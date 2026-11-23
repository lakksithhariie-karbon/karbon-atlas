/**
 * Postgres writes for the Mixpanel sync. Each IST day is replaced in one transaction (delete the day,
 * insert the day, record it in ingest.mixpanel_day_state), so a failed or repeated run never leaves a
 * half-written or double-counted day. Rows travel as one JSON parameter per table.
 */

import postgres from "npm:postgres@3.4.5";
import { DIMENSION_COLUMNS, type FactRow, type InboxRow } from "./transform.ts";

export type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

/** Connects through the transaction pooler (prepared statements off). */
export function connect(url: string | undefined): Sql {
  if (!url) throw new Error("database URL is not set");
  return postgres(url, { ssl: "require", max: 1, prepare: false, connect_timeout: 20, idle_timeout: 20 });
}

const LOCK = "mixpanel";

/** Takes or renews the shared lease. False when another run holds it. */
export async function takeLease(sql: Sql, owner: string, seconds: number): Promise<boolean> {
  const rows = await sql`
    insert into ingest.mixpanel_sync_lock (lock_name, owner, locked_until)
    values (${LOCK}, ${owner}::uuid, now() + make_interval(secs => ${seconds}))
    on conflict (lock_name) do update set owner = excluded.owner, locked_until = excluded.locked_until
    where ingest.mixpanel_sync_lock.locked_until <= now() or ingest.mixpanel_sync_lock.owner = excluded.owner
    returning owner::text as owner`;
  return rows.length > 0 && rows[0].owner === owner;
}

export async function releaseLease(sql: Sql, owner: string): Promise<void> {
  await sql`delete from ingest.mixpanel_sync_lock where lock_name = ${LOCK} and owner = ${owner}::uuid`;
}

export async function startRun(sql: Sql, runId: string, mode: string): Promise<void> {
  await sql`insert into ingest.mixpanel_sync_runs (run_id, mode, status) values (${runId}::uuid, ${mode}, 'running')`;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  r: { status: string; firstDay: string | null; lastDay: string | null; counts: unknown; requests: number; error: string | null },
): Promise<void> {
  await sql`
    update ingest.mixpanel_sync_runs set
      finished_at = now(), status = ${r.status}, first_day = ${r.firstDay}::date, last_day = ${r.lastDay}::date,
      counts = ${sql.json(r.counts as unknown as postgres.JSONValue)}, requests = ${r.requests}, error = ${r.error}
    where run_id = ${runId}::uuid`;
}

const FACT_COLUMNS = [
  "event_date", "event_name", "company_id", "user_id", ...DIMENSION_COLUMNS, "event_count", "items_sum",
  "first_at", "last_at", "transform_version",
];
const FACT_TYPES: Record<string, string> = {
  event_date: "date", company_id: "uuid", user_id: "uuid", event_count: "integer", items_sum: "bigint",
  first_at: "timestamptz", last_at: "timestamptz", transform_version: "smallint", model_predicted: "boolean",
};
const INBOX_COLUMNS = [
  "insert_id", "event_date", "event_at", "event_name", "item_id", "company_id", "org_id", "user_id", "source",
  "item_status", "route", "final_route", "previous_route", "new_route", "transform_version",
];
const INBOX_TYPES: Record<string, string> = {
  event_date: "date", event_at: "timestamptz", item_id: "uuid", company_id: "uuid", org_id: "uuid",
  user_id: "uuid", transform_version: "smallint",
};

function recordset(columns: string[], types: Record<string, string>): string {
  return columns.map((c) => `${c} ${types[c] ?? "text"}`).join(", ");
}

export interface DayWrite {
  day: string;
  runId: string;
  transformVersion: number;
  events: number;
  facts: FactRow[];
  inbox: InboxRow[];
  archivePath: string | null;
}

/** Replaces one IST day in f02_product and records it, all in one transaction. */
export async function replaceDay(sql: Sql, w: DayWrite): Promise<void> {
  const facts = w.facts.map((f) => ({
    event_date: f.event_date, event_name: f.event_name, company_id: f.company_id, user_id: f.user_id, ...f.dims,
    event_count: f.event_count, items_sum: f.items_sum, first_at: f.first_at, last_at: f.last_at,
    transform_version: w.transformVersion,
  }));
  const inbox = w.inbox.map((r) => ({ ...r, transform_version: w.transformVersion }));
  await sql.begin(async (tx: Tx) => {
    await tx`delete from f02_product.mp_event_daily_facts where event_date = ${w.day}::date`;
    await tx`delete from f02_product.mp_inbox_events where event_date = ${w.day}::date`;
    if (facts.length > 0) {
      await tx.unsafe(
        `insert into f02_product.mp_event_daily_facts (${FACT_COLUMNS.join(", ")})
         select ${FACT_COLUMNS.join(", ")} from jsonb_to_recordset($1::jsonb) as x(${recordset(FACT_COLUMNS, FACT_TYPES)})`,
        [tx.json(facts as unknown as postgres.JSONValue)],
      );
    }
    if (inbox.length > 0) {
      await tx.unsafe(
        `insert into f02_product.mp_inbox_events (${INBOX_COLUMNS.join(", ")})
         select ${INBOX_COLUMNS.join(", ")} from jsonb_to_recordset($1::jsonb) as x(${recordset(INBOX_COLUMNS, INBOX_TYPES)})
         on conflict (insert_id) do update set
           event_date = excluded.event_date, event_at = excluded.event_at, event_name = excluded.event_name,
           item_id = excluded.item_id, company_id = excluded.company_id, org_id = excluded.org_id,
           user_id = excluded.user_id, source = excluded.source, item_status = excluded.item_status,
           route = excluded.route, final_route = excluded.final_route, previous_route = excluded.previous_route,
           new_route = excluded.new_route, transform_version = excluded.transform_version`,
        [tx.json(inbox as unknown as postgres.JSONValue)],
      );
    }
    await tx`
      insert into ingest.mixpanel_day_state
        (event_date, replaced_at, run_id, transform_version, events, fact_rows, archive_path, check_status)
      values (${w.day}::date, now(), ${w.runId}::uuid, ${w.transformVersion}, ${w.events}, ${facts.length},
              ${w.archivePath}, 'not_checked')
      on conflict (event_date) do update set
        replaced_at = excluded.replaced_at, run_id = excluded.run_id, transform_version = excluded.transform_version,
        events = excluded.events, fact_rows = excluded.fact_rows,
        archive_path = coalesce(excluded.archive_path, ingest.mixpanel_day_state.archive_path),
        check_status = 'not_checked', check_ours = null, check_mixpanel = null, check_detail = null, checked_at = null`;
  });
}

/** Adds new event names, users and companies seen in a day, and widens their first/last seen dates. */
export async function upsertSeen(
  sql: Sql,
  day: string,
  eventNames: string[],
  users: string[],
  staffUsers: string[],
  staffRuleVersion: number,
  companies: Array<{ id: string; tool: string | null }>,
): Promise<void> {
  await sql.unsafe(
    `insert into f02_product.mp_events (event_name, first_seen_on, last_seen_on)
     select n, $2::date, $2::date from jsonb_array_elements_text($1::jsonb) n
     on conflict (event_name) do update set
       first_seen_on = least(f02_product.mp_events.first_seen_on, excluded.first_seen_on),
       last_seen_on = greatest(f02_product.mp_events.last_seen_on, excluded.last_seen_on)`,
    [sql.json(eventNames as unknown as postgres.JSONValue), day],
  );
  await sql.unsafe(
    `insert into f02_product.mp_users (user_id, is_internal, internal_rule_version, first_seen_on, last_seen_on)
     select u::uuid, u = any(select jsonb_array_elements_text($2::jsonb)), $3::smallint, $4::date, $4::date
     from jsonb_array_elements_text($1::jsonb) u
     on conflict (user_id) do update set
       is_internal = f02_product.mp_users.is_internal or excluded.is_internal,
       internal_rule_version = excluded.internal_rule_version,
       first_seen_on = least(f02_product.mp_users.first_seen_on, excluded.first_seen_on),
       last_seen_on = greatest(f02_product.mp_users.last_seen_on, excluded.last_seen_on)`,
    [sql.json(users as unknown as postgres.JSONValue), sql.json(staffUsers as unknown as postgres.JSONValue), staffRuleVersion, day],
  );
  await sql.unsafe(
    `insert into f02_product.mp_companies (company_id, tool_connected, first_seen_on, last_seen_on)
     select (c->>'id')::uuid, c->>'tool', $2::date, $2::date from jsonb_array_elements($1::jsonb) c
     on conflict (company_id) do update set
       tool_connected = coalesce(excluded.tool_connected, f02_product.mp_companies.tool_connected),
       first_seen_on = least(f02_product.mp_companies.first_seen_on, excluded.first_seen_on),
       last_seen_on = greatest(f02_product.mp_companies.last_seen_on, excluded.last_seen_on)`,
    [sql.json(companies as unknown as postgres.JSONValue), day],
  );
}

export async function recordUnknownFields(sql: Sql, rows: Array<[string, string, number]>): Promise<void> {
  if (rows.length === 0) return;
  await sql.unsafe(
    `insert into ingest.mixpanel_unknown_fields (event_name, field_name, occurrences)
     select r->>0, r->>1, (r->>2)::bigint from jsonb_array_elements($1::jsonb) r
     on conflict (event_name, field_name) do update set
       occurrences = ingest.mixpanel_unknown_fields.occurrences + excluded.occurrences, last_seen_at = now()`,
    [sql.json(rows as unknown as postgres.JSONValue)],
  );
}

export interface DayCheck {
  day: string;
  status: "match" | "mismatch" | "error";
  ours: number;
  mixpanel: number;
  detail: Record<string, { ours: number; mixpanel: number }> | null;
}

export async function recordChecks(sql: Sql, checks: DayCheck[]): Promise<void> {
  for (const c of checks) {
    await sql`
      update ingest.mixpanel_day_state set
        check_status = ${c.status}, check_ours = ${c.ours}, check_mixpanel = ${c.mixpanel},
        check_detail = ${c.detail ? sql.json(c.detail as unknown as postgres.JSONValue) : null}, checked_at = now()
      where event_date = ${c.day}::date`;
  }
}

/** Our per-event totals for the given IST days, read back from the facts table. */
export async function ourDailyCounts(sql: Sql, fromDay: string, toDay: string): Promise<Record<string, Record<string, number>>> {
  const rows = await sql`
    select event_date::text as day, event_name, sum(event_count)::int as n
    from f02_product.mp_event_daily_facts
    where event_date between ${fromDay}::date and ${toDay}::date
    group by 1, 2`;
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.day] ??= {})[r.event_name] = r.n;
  return out;
}

export async function catalogNames(sql: Sql): Promise<string[]> {
  const rows = await sql`select event_name from f02_product.mp_events`;
  return rows.map((r) => r.event_name as string);
}

export interface DayState {
  version: number;
  check: string;
  replacedAt: Date;
}

export async function dayStates(sql: Sql, fromDay: string, toDay: string): Promise<Map<string, DayState>> {
  const rows = await sql`
    select event_date::text as day, transform_version, check_status, replaced_at from ingest.mixpanel_day_state
    where event_date between ${fromDay}::date and ${toDay}::date`;
  return new Map(rows.map((r) => [r.day as string, {
    version: Number(r.transform_version), check: r.check_status as string, replacedAt: new Date(r.replaced_at),
  }]));
}

export async function lastProfileSync(sql: Sql): Promise<Date | null> {
  const rows = await sql`select max(profile_synced_at) as at from f02_product.mp_users`;
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

export interface UserProfileRow {
  user_id: string;
  is_internal: boolean;
  sign_up_date: string | null;
  sign_up_method: string | null;
  user_role: string | null;
}

export async function upsertUserProfiles(sql: Sql, rows: UserProfileRow[], staffRuleVersion: number): Promise<void> {
  if (rows.length === 0) return;
  await sql.unsafe(
    `insert into f02_product.mp_users (user_id, is_internal, internal_rule_version, sign_up_date, sign_up_method, user_role, profile_synced_at)
     select user_id, is_internal, $2::smallint, sign_up_date, sign_up_method, user_role, now()
     from jsonb_to_recordset($1::jsonb) as x(user_id uuid, is_internal boolean, sign_up_date date, sign_up_method text, user_role text)
     on conflict (user_id) do update set
       is_internal = f02_product.mp_users.is_internal or excluded.is_internal,
       internal_rule_version = excluded.internal_rule_version,
       sign_up_date = excluded.sign_up_date, sign_up_method = excluded.sign_up_method,
       user_role = excluded.user_role, profile_synced_at = excluded.profile_synced_at`,
    [sql.json(rows as unknown as postgres.JSONValue), staffRuleVersion],
  );
}

export interface CompanyProfileRow {
  company_id: string;
  company_name: string | null;
  organisation_id: string | null;
}

export async function upsertCompanyProfiles(sql: Sql, rows: CompanyProfileRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sql.unsafe(
    `insert into f02_product.mp_companies (company_id, company_name, organisation_id, profile_synced_at)
     select company_id, company_name, organisation_id, now()
     from jsonb_to_recordset($1::jsonb) as x(company_id uuid, company_name text, organisation_id text)
     on conflict (company_id) do update set
       company_name = excluded.company_name, organisation_id = excluded.organisation_id,
       profile_synced_at = excluded.profile_synced_at`,
    [sql.json(rows as unknown as postgres.JSONValue)],
  );
}

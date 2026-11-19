/**
 * Direct Postgres writes. One transaction per batch.
 * Clean upserts leave a row alone when every stored value already matches, so repeating a sync
 * does not change a checksum of those tables.
 */

import postgres from "npm:postgres@3.4.5";
import type {
  AttachmentRow,
  BoardRow,
  ChangeRow,
  CommentRow,
  FieldOptionRow,
  FieldRow,
  IssueRow,
  IssueSprintRow,
  IssueTypeRow,
  LinkRow,
  LinkTypeRow,
  PriorityRow,
  ProjectRow,
  SprintRow,
  StatusRow,
  TeamRow,
  UserRow,
  WorklogRow,
} from "./transform.ts";

type SqlClient = ReturnType<typeof postgres>;

export interface Db {
  query<T>(sqlText: string, params?: unknown[]): Promise<T>;
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface RawIssueWrite {
  issue_id: number;
  issue_key: string;
  payload: unknown;
  jira_updated_at: string | null;
}

export interface RawChildWrite {
  id: number;
  issue_id: number;
  payload: unknown;
}

export interface IssuePage {
  issueIds: number[];
  rawIssues: RawIssueWrite[];
  rawComments: RawChildWrite[];
  rawWorklogs: RawChildWrite[];
  rawHistories: RawChildWrite[];
  projects: ProjectRow[];
  issueTypes: IssueTypeRow[];
  statuses: StatusRow[];
  priorities: PriorityRow[];
  teams: TeamRow[];
  users: UserRow[];
  linkTypes: LinkTypeRow[];
  sprints: SprintRow[];
  issues: IssueRow[];
  comments: CommentRow[];
  changes: ChangeRow[];
  worklogs: WorklogRow[];
  attachments: AttachmentRow[];
  links: LinkRow[];
  issueSprints: IssueSprintRow[];
  /** Rebuild keeps sprint rows already loaded from the catalog. */
  sprintConflict: "update" | "ignore";
  writeRaw: boolean;
  checkpointMode: string;
  checkpoint: unknown;
}

export interface ReferencePage {
  raw: Array<{ kind: string; ref_id: string; payload: unknown }>;
  projects: ProjectRow[];
  issueTypes: IssueTypeRow[];
  statuses: StatusRow[];
  priorities: PriorityRow[];
  linkTypes: LinkTypeRow[];
  boards: BoardRow[];
  sprints: SprintRow[];
  fields: FieldRow[];
  options: FieldOptionRow[];
  checkpointMode?: string;
  checkpoint?: unknown;
}

export interface RunCounts {
  issues?: number;
  comments?: number;
  worklogs?: number;
  changelogs?: number;
  pages?: number;
  [key: string]: number | undefined;
}

const IDENTIFIER = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/;

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("bad sql identifier");
  return value;
}

function lastBy<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const map = new Map<string, T>();
  for (const row of rows) map.set(keyFn(row), row);
  return [...map.values()];
}

function asRecords<T extends object>(rows: T[]): Array<Record<string, unknown>> {
  return rows as unknown as Array<Record<string, unknown>>;
}

function wrap(sql: SqlClient): Db {
  return {
    query: (sqlText, params) => sql.unsafe(sqlText, (params ?? []) as never[]) as Promise<never>,
    begin: (fn) => sql.begin(async (tx) => await fn(wrap(tx as unknown as SqlClient))) as Promise<never>,
    end: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Connect with prepared statements off so the transaction pooler accepts the session. */
export function connect(): Db {
  const url = Deno.env.get("JIRA_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("JIRA_DB_URL is not set");
  const sql = postgres(url, {
    ssl: "require",
    max: 1,
    prepare: false,
    connect_timeout: 20,
    idle_timeout: 20,
  });
  return wrap(sql);
}

async function upsertClean(
  db: Db,
  table: string,
  columns: string[],
  conflict: string[],
  rows: Array<Record<string, unknown>>,
  options: { coalesce?: string[]; keep?: string[]; conflictAction?: "update" | "ignore" } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const target = assertIdentifier(table);
  for (const column of [...columns, ...conflict, "synced_at"]) assertIdentifier(column);
  const insertColumns = [...columns, "synced_at"];
  const selectList = [...columns, "now()"].join(", ");
  if (options.conflictAction === "ignore") {
    await db.query(
      `insert into ${target} (${insertColumns.join(", ")})
       select ${selectList}
       from json_populate_recordset(null::${target}, $1::json)
       on conflict (${conflict.join(", ")}) do nothing`,
      [rows],
    );
    return;
  }
  const dataColumns = columns.filter((column) => !conflict.includes(column));
  if (dataColumns.length === 0) {
    await db.query(
      `insert into ${target} (${insertColumns.join(", ")})
       select ${selectList}
       from json_populate_recordset(null::${target}, $1::json)
       on conflict (${conflict.join(", ")}) do nothing`,
      [rows],
    );
    return;
  }
  const coalesce = new Set(options.coalesce ?? []);
  const keep = new Set(options.keep ?? []);
  const assignments = dataColumns.map((column) => {
    if (keep.has(column)) return `${column} = coalesce(${target}.${column}, excluded.${column})`;
    if (coalesce.has(column)) return `${column} = coalesce(excluded.${column}, ${target}.${column})`;
    return `${column} = excluded.${column}`;
  });
  assignments.push("synced_at = now()");
  const comparisons = dataColumns.map((column) => {
    if (keep.has(column)) return `(${target}.${column} is null and excluded.${column} is not null)`;
    if (coalesce.has(column)) {
      return `(excluded.${column} is not null and ${target}.${column} is distinct from excluded.${column})`;
    }
    return `${target}.${column} is distinct from excluded.${column}`;
  });
  await db.query(
    `insert into ${target} (${insertColumns.join(", ")})
     select ${selectList}
     from json_populate_recordset(null::${target}, $1::json)
     on conflict (${conflict.join(", ")}) do update set
       ${assignments.join(",\n")}
     where ${comparisons.join(" or ")}`,
    [rows],
  );
}

async function saveCheckpoint(db: Db, mode: string, checkpoint: unknown): Promise<void> {
  await db.query(
    `insert into ingest.jira_sync_state (mode, checkpoint, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (mode) do update set checkpoint = excluded.checkpoint, updated_at = now()`,
    [mode, checkpoint],
  );
}

async function replaceIssueChildren(
  db: Db,
  table: string,
  columns: string[],
  conflict: string[],
  rows: Array<Record<string, unknown>>,
  issueIds: number[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const target = assertIdentifier(table);
  const keyMatch = conflict.map((column) => `n.${assertIdentifier(column)} = t.${column}`).join(" and ");
  await db.query(
    `delete from ${target} t
     where t.issue_id in (select value::bigint from json_array_elements_text($1::json))
       and not exists (
         select 1 from json_populate_recordset(null::${target}, $2::json) n
         where ${keyMatch}
       )`,
    [issueIds, rows],
  );
  await upsertClean(db, table, columns, conflict, rows);
}

async function replaceRawChildren(
  db: Db,
  table: string,
  idColumn: string,
  rows: RawChildWrite[],
  issueIds: number[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const target = assertIdentifier(table);
  const column = assertIdentifier(idColumn);
  const payload = lastBy(rows, (row) => String(row.id)).map((row) => ({
    [column]: row.id,
    issue_id: row.issue_id,
    payload: row.payload,
  }));
  await db.query(
    `delete from ${target} t
     where t.issue_id in (select value::bigint from json_array_elements_text($1::json))
       and not exists (
         select 1 from json_populate_recordset(null::${target}, $2::json) n
         where n.${column} = t.${column}
       )`,
    [issueIds, payload],
  );
  if (payload.length === 0) return;
  await db.query(
    `insert into ${target} (${column}, issue_id, payload, fetched_at)
     select ${column}, issue_id, payload, now()
     from json_populate_recordset(null::${target}, $1::json)
     on conflict (${column}) do update set
       issue_id = excluded.issue_id,
       payload = excluded.payload,
       fetched_at = now()`,
    [payload],
  );
}

const ISSUE_COLUMNS = [
  "issue_id", "issue_key", "project_id", "summary", "description_text", "description_adf",
  "issue_type_id", "parent_issue_id", "status_id", "resolution", "priority_id", "flagged",
  "assignee_account_id", "reporter_account_id", "creator_account_id", "team_id",
  "created_at", "updated_at", "resolved_at", "status_changed_at", "due_date", "start_date",
  "story_points", "original_estimate_seconds", "remaining_estimate_seconds", "time_spent_seconds",
  "module", "module_tags", "sub_module_tags", "feature", "environment", "severity",
  "root_cause_tags", "source_tags", "labels", "comment_count", "attachment_count", "watcher_count",
  "deleted_at",
];

export async function writeIssuePage(db: Db, page: IssuePage): Promise<void> {
  await db.begin(async (tx) => {
    await tx.query(`select set_config('statement_timeout', '120000', true)`);
    if (page.writeRaw) {
      const rawIssues = lastBy(page.rawIssues, (row) => String(row.issue_id)).map((row) => ({
        issue_id: row.issue_id,
        issue_key: row.issue_key,
        payload: row.payload,
        jira_updated_at: row.jira_updated_at,
      }));
      if (rawIssues.length > 0) {
        await tx.query(
          `insert into ingest.jira_issue_raw (issue_id, issue_key, payload, jira_updated_at, fetched_at, deleted_at)
           select issue_id, issue_key, payload, jira_updated_at, now(), null::timestamptz
           from json_populate_recordset(null::ingest.jira_issue_raw, $1::json)
           on conflict (issue_id) do update set
             issue_key = excluded.issue_key,
             payload = excluded.payload,
             jira_updated_at = excluded.jira_updated_at,
             fetched_at = now(),
             deleted_at = null`,
          [rawIssues],
        );
      }
      await replaceRawChildren(tx, "ingest.jira_comment_raw", "comment_id", page.rawComments, page.issueIds);
      await replaceRawChildren(tx, "ingest.jira_worklog_raw", "worklog_id", page.rawWorklogs, page.issueIds);
      await replaceRawChildren(tx, "ingest.jira_changelog_raw", "history_id", page.rawHistories, page.issueIds);
    }

    await upsertClean(tx, "f01_engineering.jira_projects", [
      "project_id", "project_key", "name", "project_type", "style",
    ], ["project_id"], asRecords(lastBy(page.projects, (row) => String(row.project_id))), { coalesce: ["style"] });
    await upsertClean(tx, "f01_engineering.jira_issue_types", [
      "issue_type_id", "name", "hierarchy_level", "is_subtask",
    ], ["issue_type_id"], asRecords(lastBy(page.issueTypes, (row) => String(row.issue_type_id))));
    await upsertClean(tx, "f01_engineering.jira_statuses", [
      "status_id", "name", "category_key", "category_name",
    ], ["status_id"], asRecords(lastBy(page.statuses, (row) => String(row.status_id))));
    await upsertClean(tx, "f01_engineering.jira_priorities", [
      "priority_id", "name", "sort_order",
    ], ["priority_id"], asRecords(lastBy(page.priorities, (row) => String(row.priority_id))), { coalesce: ["sort_order"] });
    await upsertClean(tx, "f01_engineering.jira_teams", [
      "team_id", "name",
    ], ["team_id"], asRecords(lastBy(page.teams, (row) => row.team_id)));
    await upsertClean(tx, "f01_engineering.jira_users", [
      "account_id", "display_name", "account_type", "active", "time_zone",
    ], ["account_id"], asRecords(lastBy(page.users, (row) => row.account_id)), {
      keep: ["display_name", "account_type", "active", "time_zone"],
    });
    await upsertClean(tx, "f01_engineering.jira_link_types", [
      "link_type_id", "name", "outward", "inward",
    ], ["link_type_id"], asRecords(lastBy(page.linkTypes, (row) => String(row.link_type_id))));
    await upsertClean(
      tx,
      "f01_engineering.jira_sprints",
      ["sprint_id", "board_id", "name", "state", "start_at", "end_at", "complete_at", "goal"],
      ["sprint_id"],
      asRecords(lastBy(page.sprints, (row) => String(row.sprint_id))),
      { conflictAction: page.sprintConflict === "ignore" ? "ignore" : "update" },
    );
    await upsertClean(
      tx,
      "f01_engineering.jira_issues",
      ISSUE_COLUMNS,
      ["issue_id"],
      asRecords(lastBy(page.issues, (row) => String(row.issue_id))),
    );

    const issueIds = page.issueIds;
    await replaceIssueChildren(tx, "f01_engineering.jira_comments", [
      "comment_id", "issue_id", "author_account_id", "update_author_account_id",
      "created_at", "updated_at", "body_text", "body_adf", "visibility",
    ], ["comment_id"], asRecords(lastBy(page.comments, (row) => String(row.comment_id))), issueIds);
    await replaceIssueChildren(tx, "f01_engineering.jira_issue_changes", [
      "history_id", "item_index", "issue_id", "author_account_id", "changed_at",
      "field", "field_id", "field_type", "from_value", "from_display", "to_value", "to_display",
    ], ["history_id", "item_index"], asRecords(lastBy(page.changes, (row) => `${row.history_id}:${row.item_index}`)), issueIds);
    await replaceIssueChildren(tx, "f01_engineering.jira_worklogs", [
      "worklog_id", "issue_id", "author_account_id", "started_at", "time_spent_seconds",
      "created_at", "updated_at", "comment_text",
    ], ["worklog_id"], asRecords(lastBy(page.worklogs, (row) => String(row.worklog_id))), issueIds);
    await replaceIssueChildren(tx, "f01_engineering.jira_attachments", [
      "attachment_id", "issue_id", "filename", "mime_type", "size_bytes",
      "author_account_id", "created_at", "content_url",
    ], ["attachment_id"], asRecords(lastBy(page.attachments, (row) => String(row.attachment_id))), issueIds);
    await replaceIssueChildren(tx, "f01_engineering.jira_issue_sprints", [
      "issue_id", "sprint_id",
    ], ["issue_id", "sprint_id"], asRecords(lastBy(page.issueSprints, (row) => `${row.issue_id}:${row.sprint_id}`)), issueIds);

    if (issueIds.length > 0) {
      const links = asRecords(lastBy(page.links, (row) => String(row.link_id)));
      await tx.query(
        `delete from f01_engineering.jira_issue_links t
         where (t.outward_issue_id in (select value::bigint from json_array_elements_text($1::json))
             or t.inward_issue_id in (select value::bigint from json_array_elements_text($1::json)))
           and not exists (
             select 1 from json_populate_recordset(null::f01_engineering.jira_issue_links, $2::json) n
             where n.link_id = t.link_id
           )`,
        [issueIds, links],
      );
      await upsertClean(tx, "f01_engineering.jira_issue_links", [
        "link_id", "link_type_id", "outward_issue_id", "inward_issue_id", "outward_issue_key", "inward_issue_key",
      ], ["link_id"], links);
    }

    await saveCheckpoint(tx, page.checkpointMode, page.checkpoint);
  });
}

export async function writeReferencePage(db: Db, page: ReferencePage): Promise<void> {
  await db.begin(async (tx) => {
    await tx.query(`select set_config('statement_timeout', '120000', true)`);
    if (page.raw.length > 0) {
      await tx.query(
        `insert into ingest.jira_reference_raw (kind, ref_id, payload, fetched_at)
         select kind, ref_id, payload, now()
         from json_populate_recordset(null::ingest.jira_reference_raw, $1::json)
         on conflict (kind, ref_id) do update set payload = excluded.payload, fetched_at = now()`,
        [lastBy(page.raw, (row) => `${row.kind}:${row.ref_id}`)],
      );
    }
    await upsertClean(tx, "f01_engineering.jira_projects", [
      "project_id", "project_key", "name", "project_type", "style",
    ], ["project_id"], asRecords(lastBy(page.projects, (row) => String(row.project_id))), { coalesce: ["style"] });
    await upsertClean(tx, "f01_engineering.jira_issue_types", [
      "issue_type_id", "name", "hierarchy_level", "is_subtask",
    ], ["issue_type_id"], asRecords(lastBy(page.issueTypes, (row) => String(row.issue_type_id))));
    await upsertClean(tx, "f01_engineering.jira_statuses", [
      "status_id", "name", "category_key", "category_name",
    ], ["status_id"], asRecords(lastBy(page.statuses, (row) => String(row.status_id))));
    await upsertClean(tx, "f01_engineering.jira_priorities", [
      "priority_id", "name", "sort_order",
    ], ["priority_id"], asRecords(lastBy(page.priorities, (row) => String(row.priority_id))), { coalesce: ["sort_order"] });
    await upsertClean(tx, "f01_engineering.jira_link_types", [
      "link_type_id", "name", "outward", "inward",
    ], ["link_type_id"], asRecords(lastBy(page.linkTypes, (row) => String(row.link_type_id))));
    await upsertClean(tx, "f01_engineering.jira_boards", [
      "board_id", "name", "board_type", "location_project_id", "filter_jql",
    ], ["board_id"], asRecords(lastBy(page.boards, (row) => String(row.board_id))));
    await upsertClean(tx, "f01_engineering.jira_sprints", [
      "sprint_id", "board_id", "name", "state", "start_at", "end_at", "complete_at", "goal",
    ], ["sprint_id"], asRecords(lastBy(page.sprints, (row) => String(row.sprint_id))));
    await upsertClean(tx, "f01_engineering.jira_fields", [
      "field_id", "jira_name", "column_name", "schema_type", "is_custom", "description",
    ], ["field_id"], asRecords(lastBy(page.fields, (row) => row.field_id)), { coalesce: ["description"] });
    await upsertClean(tx, "f01_engineering.jira_field_options", [
      "field_id", "option_id", "value", "is_disabled",
    ], ["field_id", "option_id"], asRecords(lastBy(page.options, (row) => `${row.field_id}:${row.option_id}`)));
    if (page.checkpointMode && page.checkpoint !== undefined) {
      await saveCheckpoint(tx, page.checkpointMode, page.checkpoint);
    }
  });
}

export async function markDeletions(db: Db, issueIds: number[]): Promise<void> {
  await db.begin(async (tx) => {
    await tx.query(`select set_config('statement_timeout', '120000', true)`);
    await tx.query(
      `update ingest.jira_issue_raw
       set deleted_at = now()
       where deleted_at is null
         and issue_id not in (select value::bigint from json_array_elements_text($1::json))`,
      [issueIds],
    );
    await tx.query(
      `update ingest.jira_issue_raw
       set deleted_at = null
       where deleted_at is not null
         and issue_id in (select value::bigint from json_array_elements_text($1::json))`,
      [issueIds],
    );
    await tx.query(
      `update f01_engineering.jira_issues
       set deleted_at = now(), synced_at = now()
       where deleted_at is null
         and issue_id not in (select value::bigint from json_array_elements_text($1::json))`,
      [issueIds],
    );
    await tx.query(
      `update f01_engineering.jira_issues
       set deleted_at = null, synced_at = now()
       where deleted_at is not null
         and issue_id in (select value::bigint from json_array_elements_text($1::json))`,
      [issueIds],
    );
  });
}

export async function readCheckpoint(db: Db, mode: string): Promise<Record<string, unknown>> {
  const rows = await db.query<Array<{ checkpoint: Record<string, unknown> | null }>>(
    `select checkpoint from ingest.jira_sync_state where mode = $1`,
    [mode],
  );
  const checkpoint = rows[0]?.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return {};
  return checkpoint;
}

export async function writeCheckpoint(db: Db, mode: string, checkpoint: unknown): Promise<void> {
  await saveCheckpoint(db, mode, checkpoint);
}

export async function maxRawUpdated(db: Db): Promise<string | null> {
  const rows = await db.query<Array<{ max: unknown }>>(
    `select max(jira_updated_at) as max from ingest.jira_issue_raw`,
  );
  return instant(rows[0]?.max);
}

export async function readRawIssueBatch(
  db: Db,
  afterId: number,
  limit: number,
): Promise<Array<{ issue_id: unknown; payload: unknown; deleted_at: unknown }>> {
  return await db.query(
    `select issue_id, payload, deleted_at
     from ingest.jira_issue_raw
     where issue_id > $1
     order by issue_id
     limit $2`,
    [afterId, limit],
  );
}

export async function readRawChildren(
  db: Db,
  table: "jira_comment_raw" | "jira_worklog_raw" | "jira_changelog_raw",
  idColumn: "comment_id" | "worklog_id" | "history_id",
  issueIds: number[],
): Promise<Array<{ id: unknown; issue_id: unknown; payload: unknown }>> {
  const target = assertIdentifier(`ingest.${table}`);
  const column = assertIdentifier(idColumn);
  return await db.query(
    `select ${column} as id, issue_id, payload
     from ${target}
     where issue_id in (select value::bigint from json_array_elements_text($1::json))
     order by issue_id, ${column}`,
    [issueIds],
  );
}

export async function readReference(
  db: Db,
): Promise<Array<{ kind: string; ref_id: string; payload: unknown }>> {
  return await db.query(
    `select kind, ref_id, payload from ingest.jira_reference_raw`,
  );
}

export async function insertRun(db: Db, mode: string, startedAt: string): Promise<string> {
  const rows = await db.query<Array<{ run_id: string }>>(
    `insert into ingest.jira_sync_runs (mode, started_at, status, counts, requests)
     values ($1, $2::timestamptz, 'partial', '{}'::jsonb, 0)
     returning run_id::text as run_id`,
    [mode, startedAt],
  );
  const runId = rows[0]?.run_id;
  if (!runId) throw new Error("database error");
  return runId;
}

export async function finishRun(
  db: Db,
  runId: string,
  status: "ok" | "partial" | "skipped" | "error",
  counts: RunCounts,
  requests: number,
  error: string | null,
): Promise<void> {
  await db.query(
    `update ingest.jira_sync_runs
     set finished_at = now(), status = $2, counts = $3::jsonb, requests = $4, error = $5
     where run_id = $1::uuid`,
    [runId, status, counts, requests, error],
  );
}

export function instant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export function asId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("bad id");
}

/**
 * The Mixpanel sync, shared by the Edge Function (incremental, weekly, rebuild) and the local backfill.
 *
 * For each IST day D, in order: fetch the UTC days D-1 and D from Raw Export (an IST day spans both),
 * clean them (dedupe, allowlist, ids, staff), write the archive file, then replace day D in Postgres in
 * one transaction. Afterwards, compare each finished day's per-event totals with Mixpanel's report API.
 */

import {
  archiveLines,
  buildFacts,
  buildInbox,
  type CleanEvent,
  cleanEvents,
  type CleanStats,
  emptyStats,
  isStaffEmail,
  istDay,
  type MixpanelEvent,
  parseArchive,
  safeText,
  toolByCompany,
  unknownFieldRows,
} from "./transform.ts";
import { FIRST_DAY, STAFF_RULE_VERSION, TRANSFORM_VERSION } from "./version.ts";
import { readArchive, type StorageConfig, writeArchive } from "./archive.ts";
import type { Mixpanel } from "./mixpanel.ts";
import * as db from "./db.ts";

export type Mode = "incremental" | "weekly" | "rebuild" | "backfill";

export interface Deps {
  sql: db.Sql;
  mp: Mixpanel;
  storage: StorageConfig;
  log: (message: string) => void;
  /** Stop starting new days after this many milliseconds. */
  budgetMs: number;
  /** Minimum gap between Raw Export calls (the backfill paces itself under Mixpanel's 60 per hour). */
  exportGapMs?: number;
}

const DAY_MS = 86_400_000;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function todayIst(now = Date.now()): string {
  return istDay(Math.floor(now / 1000));
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface DaysResult {
  done: string[];
  stats: CleanStats;
  events: number;
  factRows: number;
  inboxRows: number;
  stoppedEarly: boolean;
}

/** Replaces each IST day in `days` (ascending), reading from Mixpanel or from the archive. */
export async function syncDays(deps: Deps, runId: string, days: string[], source: "mixpanel" | "archive"): Promise<DaysResult> {
  const started = Date.now();
  const stats = emptyStats();
  const result: DaysResult = { done: [], stats, events: 0, factRows: 0, inboxRows: 0, stoppedEarly: false };
  const utcCache = new Map<string, MixpanelEvent[]>();
  let lastExport = 0;

  const utcDay = async (day: string): Promise<MixpanelEvent[]> => {
    const cached = utcCache.get(day);
    if (cached) return cached;
    if (deps.exportGapMs) {
      const wait = lastExport + deps.exportGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    lastExport = Date.now();
    const events = await deps.mp.exportUtcDay(day);
    utcCache.set(day, events);
    return events;
  };

  for (const day of days) {
    if (Date.now() - started > deps.budgetMs) {
      result.stoppedEarly = true;
      break;
    }
    let events: CleanEvent[];
    let staff: string[] = [];
    if (source === "mixpanel") {
      const raw = [...await utcDay(addDays(day, -1)), ...await utcDay(day)];
      const cleaned = cleanEvents(raw, stats);
      events = cleaned.events.filter((e) => istDay(e.time) === day);
      staff = [...cleaned.staffUsers];
      utcCache.delete(addDays(day, -1));
    } else {
      events = parseArchive(await readArchive(deps.storage, day));
    }

    const path = source === "mixpanel" ? await writeArchive(deps.storage, day, archiveLines(day, events)) : null;
    const facts = buildFacts(day, events);
    const inbox = buildInbox(day, events);
    await db.replaceDay(deps.sql, {
      day, runId, transformVersion: TRANSFORM_VERSION, events: events.length, facts, inbox, archivePath: path,
    });

    const users = [...new Set(events.map((e) => e.user_id).filter((u): u is string => u !== null))];
    const tools = toolByCompany(events);
    const companies = [...new Set(events.map((e) => e.company_id).filter((c): c is string => c !== null))]
      .map((id) => ({ id, tool: tools.get(id) ?? null }));
    for (const [id, tool] of tools) if (!companies.some((c) => c.id === id)) companies.push({ id, tool });
    await db.upsertSeen(deps.sql, day, [...new Set(events.map((e) => e.event))], users, staff, STAFF_RULE_VERSION, companies);

    result.done.push(day);
    result.events += events.length;
    result.factRows += facts.length;
    result.inboxRows += inbox.length;
    deps.log(`day ${day}: ${events.length} events, ${facts.length} fact rows, ${inbox.length} inbox rows`);
  }
  await db.recordUnknownFields(deps.sql, unknownFieldRows(stats));
  return result;
}

function sum(m: Record<string, number>): number {
  return Object.values(m).reduce((s, n) => s + n, 0);
}

/**
 * Compares our per-event totals with Mixpanel's report API for each day. Today is skipped: it is still
 * filling up, and the next run after midnight checks it as yesterday.
 */
export async function checkDays(deps: Deps, days: string[]): Promise<db.DayCheck[]> {
  const today = todayIst();
  const finished = days.filter((d) => d < today).toSorted();
  if (finished.length === 0) return [];
  const from = finished[0];
  const to = finished[finished.length - 1];
  const ours = await db.ourDailyCounts(deps.sql, from, to);
  const names = new Set<string>([...await deps.mp.eventNames(), ...await db.catalogNames(deps.sql)]);
  for (const byEvent of Object.values(ours)) for (const e of Object.keys(byEvent)) names.add(e);
  const theirs = await deps.mp.dailyCounts([...names].toSorted(), from, to);
  const checks: db.DayCheck[] = [];
  for (const day of finished) {
    const a = ours[day] ?? {};
    const b = theirs[day] ?? {};
    const detail: Record<string, { ours: number; mixpanel: number }> = {};
    for (const e of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[e] ?? 0) !== (b[e] ?? 0)) detail[e] = { ours: a[e] ?? 0, mixpanel: b[e] ?? 0 };
    }
    const ok = Object.keys(detail).length === 0;
    checks.push({ day, status: ok ? "match" : "mismatch", ours: sum(a), mixpanel: sum(b), detail: ok ? null : detail });
  }
  await db.recordChecks(deps.sql, checks);
  return checks;
}

const DATE = /^\d{4}-\d{2}-\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refreshes user and company profiles. Emails are read only to set the staff flag and never stored;
 * names and phones are never requested.
 */
export async function refreshProfiles(deps: Deps): Promise<{ users: number; companies: number }> {
  const stats = emptyStats();
  const users = (await deps.mp.profiles(["$email", "signUpDate", "signUpMethod", "userRole"]))
    .filter((p) => UUID.test(p.id))
    .map((p) => {
      const signUp = p.props["signUpDate"];
      return {
        user_id: p.id.toLowerCase(),
        is_internal: isStaffEmail(p.props["$email"]),
        sign_up_date: typeof signUp === "string" && DATE.test(signUp) ? signUp.slice(0, 10) : null,
        sign_up_method: safeText(p.props["signUpMethod"], "signUpMethod", stats),
        user_role: safeText(p.props["userRole"], "userRole", stats),
      };
    });
  await db.upsertUserProfiles(deps.sql, users, STAFF_RULE_VERSION);

  let companies: db.CompanyProfileRow[] = [];
  const group = await deps.mp.companyGroupId();
  if (group !== null) {
    companies = (await deps.mp.profiles(["companyName", "organisationId"], group))
      .filter((p) => UUID.test(p.id))
      .map((p) => {
        const name = p.props["companyName"];
        return {
          company_id: p.id.toLowerCase(),
          company_name: typeof name === "string" && !name.includes("@") ? name.trim().slice(0, 200) || null : null,
          organisation_id: safeText(p.props["organisationId"], "organisationId", stats),
        };
      });
    await db.upsertCompanyProfiles(deps.sql, companies);
  }
  deps.log(`profiles: ${users.length} users, ${companies.length} companies`);
  return { users: users.length, companies: companies.length };
}

export interface RunResult {
  run_id: string;
  mode: Mode;
  status: "ok" | "partial" | "skipped" | "error";
  first_day: string | null;
  last_day: string | null;
  counts: Record<string, unknown>;
  error?: string;
}

/** Days a mode covers. */
export function daysFor(mode: Mode, opts: { from?: string; to?: string } = {}, now = Date.now()): string[] {
  const today = todayIst(now);
  if (mode === "incremental") return [addDays(today, -1), today];
  if (mode === "weekly") return dayRange(addDays(today, -13), today);
  const from = opts.from && opts.from > FIRST_DAY ? opts.from : FIRST_DAY;
  const to = opts.to && opts.to < today ? opts.to : addDays(today, -1);
  return dayRange(from, to);
}

/** One full run: lease, run log, days, check, profiles (incremental, at most daily), release. */
export async function runMode(
  deps: Deps,
  mode: Mode,
  opts: { from?: string; to?: string; days?: string[]; profiles?: "auto" | "force" | "skip" } = {},
): Promise<RunResult> {
  const runId = crypto.randomUUID();
  const leaseSeconds = Math.ceil(deps.budgetMs / 1000) + 120;
  if (!await db.takeLease(deps.sql, runId, leaseSeconds)) {
    return { run_id: runId, mode, status: "skipped", first_day: null, last_day: null, counts: {} };
  }
  await db.startRun(deps.sql, runId, mode);
  const counts: Record<string, unknown> = {};
  let status: RunResult["status"] = "ok";
  let error: string | undefined;
  let done: string[] = [];
  try {
    let days = opts.days ?? daysFor(mode, opts);
    if (mode === "rebuild") {
      const states = await db.dayStates(deps.sql, days[0], days[days.length - 1]);
      days = days.filter((d) => (states.get(d)?.version ?? TRANSFORM_VERSION) < TRANSFORM_VERSION);
    }
    const r = await syncDays(deps, runId, days, mode === "rebuild" ? "archive" : "mixpanel");
    done = r.done;
    Object.assign(counts, {
      days: r.done.length, events: r.events, fact_rows: r.factRows, inbox_rows: r.inboxRows,
      duplicates: r.stats.duplicates, invalid_ids: r.stats.invalid_ids, redacted_values: r.stats.redacted_values,
      unknown_fields: Object.keys(r.stats.unknown_fields).length,
    });
    if (r.stoppedEarly) status = "partial";
    const checks = await checkDays(deps, r.done);
    counts.checked_days = checks.length;
    counts.mismatched_days = checks.filter((c) => c.status !== "match").map((c) => c.day);
    const wantProfiles = opts.profiles ?? (mode === "incremental" ? "auto" : "skip");
    if (wantProfiles !== "skip") {
      const last = await db.lastProfileSync(deps.sql);
      if (wantProfiles === "force" || !last || Date.now() - last.getTime() > 20 * 3600_000) {
        counts.profiles = await refreshProfiles(deps);
      }
    }
  } catch (e) {
    status = "error";
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    deps.log(`error: ${error}`);
  } finally {
    counts.mixpanel_requests = deps.mp.requests;
    await db.finishRun(deps.sql, runId, {
      status, firstDay: done[0] ?? null, lastDay: done[done.length - 1] ?? null, counts,
      requests: deps.mp.requests, error: error ?? null,
    });
    await db.releaseLease(deps.sql, runId);
  }
  return { run_id: runId, mode, status, first_day: done[0] ?? null, last_day: done[done.length - 1] ?? null, counts, error };
}

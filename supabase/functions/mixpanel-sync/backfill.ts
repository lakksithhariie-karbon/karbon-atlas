/**
 * One-time history load, run locally (not in the Edge runtime, whose 150-second limit fits a few days,
 * not eleven months). Same code path as the Edge Function: runMode() from sync.ts.
 *
 *   deno run --no-lock --allow-net --allow-read --allow-env supabase/functions/mixpanel-sync/backfill.ts \
 *     [--from 2026-01-01] [--to <yesterday>] [--chunk 20] [--force] [--profiles]
 *
 * Reads credentials from .secrets/.env at the repo root and never prints them. Resumable: days already
 * built by the current TRANSFORM_VERSION are skipped unless --force. Paces Raw Export at one call per
 * 70 seconds (Mixpanel allows 60 per hour), so a full year takes about six and a half hours. A rate
 * limit (HTTP 429) or a scheduled run holding the lease pauses it; it then resumes on its own. At the end it
 * checks any day in the range that was built but never checked.
 */

import { connect } from "./db.ts";
import { Mixpanel } from "./mixpanel.ts";
import { addDays, checkDays, dayRange, runMode, todayIst } from "./sync.ts";
import { FIRST_DAY, TRANSFORM_VERSION } from "./version.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

function readEnv(path: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of Deno.readTextFileSync(path).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env.set(m[1], m[2].replace(/^["']|["']$/g, ""));
  }
  return env;
}

async function management<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.supabase.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Management API ${path.split("?")[0]} HTTP ${res.status}`);
  return await res.json() as T;
}

const root = new URL("../../../", import.meta.url);
const env = readEnv(new URL(".secrets/.env", root).pathname);
const need = (k: string) => {
  const v = env.get(k);
  if (!v) throw new Error(`${k} is missing from .secrets/.env`);
  return v;
};
const ref = need("SUPABASE_PROJECT_REF").replace(/^https?:\/\//, "").split(".")[0];
const token = need("SUPABASE_ACCESS_TOKEN");

const pooler = await management<Array<{ db_host: string; db_port: number; db_user: string; db_name: string; pool_mode: string }>>(
  token, `/projects/${ref}/config/database/pooler`);
const tx = pooler.find((p) => p.pool_mode === "transaction") ?? pooler[0];
const dbUrl = `postgresql://${encodeURIComponent(tx.db_user)}:${encodeURIComponent(need("SUPABASE_DB_PASSWORD"))}@${tx.db_host}:${tx.db_port}/${tx.db_name}`;
const keys = await management<Array<{ name: string; type?: string; api_key: string }>>(token, `/projects/${ref}/api-keys?reveal=true`);
const serviceKey = (keys.find((k) => k.name === "service_role") ?? keys.find((k) => k.type === "secret"))?.api_key;
if (!serviceKey) throw new Error("no service role key found");

const sql = connect(dbUrl);
const mp = new Mixpanel({
  projectId: need("MIXPANEL_PROJECT_ID"),
  username: need("MIXPANEL_SERVICE_ACCOUNT_USERNAME"),
  secret: need("MIXPANEL_SERVICE_ACCOUNT_SECRET"),
});
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const from = arg("from") ?? FIRST_DAY;
const to = arg("to") ?? addDays(todayIst(), -1);
const chunk = Number(arg("chunk") ?? 20);
const force = Deno.args.includes("--force");

try {
  const startedAt = new Date().toISOString();
  const deps = {
    sql, mp, storage: { url: `https://${ref}.supabase.co`, serviceKey }, log, budgetMs: 40 * 60_000,
    // 70 s per export keeps the backfill near 51 calls an hour, leaving room under Mixpanel's 60 for
    // the scheduled runs and anything else using the project's export quota.
    exportGapMs: 70_000,
  };
  // Days still to build: missing, built by an older transform, or (with --force) built before this run.
  const remaining = async (): Promise<string[]> => {
    const rows = await sql`
      select event_date::text as day from ingest.mixpanel_day_state
      where event_date between ${from}::date and ${to}::date and transform_version = ${TRANSFORM_VERSION}
        and (${!force} or replaced_at >= ${startedAt}::timestamptz)`;
    const built = new Set(rows.map((r) => r.day as string));
    return dayRange(from, to).filter((d) => !built.has(d));
  };
  log(`backfill ${from}..${to}: ${(await remaining()).length} days to build, transform v${TRANSFORM_VERSION}`);
  let waits = 0;
  for (;;) {
    const pending = await remaining();
    if (pending.length === 0) break;
    const days = pending.slice(0, chunk);
    const result = await runMode(deps, "backfill", { days, profiles: pending.length <= chunk ? "force" : "skip" });
    log(`chunk ${days[0]}..${days[days.length - 1]}: ${result.status} ${JSON.stringify(result.counts)}${result.error ? ` error=${result.error}` : ""}`);
    if (result.status === "ok" || result.status === "partial") {
      waits = 0;
      continue;
    }
    // A scheduled run holds the lease for under two minutes; a rate limit clears within the hour.
    const rateLimited = result.error?.includes("HTTP 429") ?? false;
    if (result.status !== "skipped" && !rateLimited) Deno.exit(1);
    if (++waits > 8) Deno.exit(1);
    const minutes = rateLimited ? 15 : 2;
    log(`${rateLimited ? "Mixpanel rate limit" : "lease held by a scheduled run"}; resuming in ${minutes} minutes`);
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
  // Days built but never checked (a run stopped between replacing a chunk and checking it).
  const unchecked = (await sql`
    select event_date::text as day from ingest.mixpanel_day_state
    where event_date between ${from}::date and ${to}::date and check_status <> 'match'
    order by event_date`).map((r) => r.day as string);
  if (unchecked.length > 0) {
    const checks = await checkDays(deps, unchecked);
    const bad = checks.filter((c) => c.status !== "match").map((c) => c.day);
    log(`checked ${checks.length} unchecked days: ${bad.length === 0 ? "all match" : `mismatched ${bad.join(", ")}`}`);
  }
  if (Deno.args.includes("--profiles")) {
    await runMode({ ...deps, budgetMs: 600_000 }, "backfill", { days: [], profiles: "force" });
  }
  log("backfill finished");
} finally {
  await sql.end({ timeout: 5 });
}

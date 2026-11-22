/**
 * One-time history load, run locally (not in the Edge runtime, whose 150-second limit fits a few days,
 * not eleven months). Same code path as the Edge Function: runMode() from sync.ts.
 *
 *   deno run --no-lock --allow-net --allow-read --allow-env supabase/functions/mixpanel-sync/backfill.ts \
 *     [--from 2026-01-01] [--to <yesterday>] [--chunk 20] [--force] [--profiles]
 *
 * Reads credentials from .secrets/.env at the repo root and never prints them. Resumable: days already
 * built by the current TRANSFORM_VERSION are skipped unless --force. Paces Raw Export at one call per
 * 65 seconds (Mixpanel allows 60 per hour), so a full year takes about six hours.
 */

import { connect } from "./db.ts";
import { Mixpanel } from "./mixpanel.ts";
import { addDays, dayRange, runMode, todayIst } from "./sync.ts";
import { dayStates } from "./db.ts";
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
  const states = await dayStates(sql, from, to);
  const pending = dayRange(from, to).filter((d) => force || states.get(d)?.version !== TRANSFORM_VERSION);
  log(`backfill ${from}..${to}: ${pending.length} days to build, transform v${TRANSFORM_VERSION}`);
  for (let i = 0; i < pending.length; i += chunk) {
    const days = pending.slice(i, i + chunk);
    const last = i + chunk >= pending.length;
    let result = await runMode(
      { sql, mp, storage: { url: `https://${ref}.supabase.co`, serviceKey }, log, budgetMs: 40 * 60_000, exportGapMs: 65_000 },
      "backfill",
      { days, profiles: last && (Deno.args.includes("--profiles") || pending.length > 0) ? "force" : "skip" },
    );
    // A scheduled run holds the shared lease for under two minutes; wait for it rather than stop.
    for (let tries = 0; result.status === "skipped" && tries < 10; tries += 1) {
      log("lease held by a scheduled run; retrying in 2 minutes");
      await new Promise((r) => setTimeout(r, 120_000));
      result = await runMode(
        { sql, mp, storage: { url: `https://${ref}.supabase.co`, serviceKey }, log, budgetMs: 40 * 60_000, exportGapMs: 65_000 },
        "backfill",
        { days, profiles: last ? "force" : "skip" },
      );
    }
    log(`chunk ${days[0]}..${days[days.length - 1]}: ${result.status} ${JSON.stringify(result.counts)}${result.error ? ` error=${result.error}` : ""}`);
    if (result.status === "error" || result.status === "skipped") Deno.exit(1);
  }
  if (pending.length === 0 && Deno.args.includes("--profiles")) {
    await runMode({ sql, mp, storage: { url: `https://${ref}.supabase.co`, serviceKey }, log, budgetMs: 600_000 }, "backfill", { days: [], profiles: "force" });
  }
  log("backfill finished");
} finally {
  await sql.end({ timeout: 5 });
}

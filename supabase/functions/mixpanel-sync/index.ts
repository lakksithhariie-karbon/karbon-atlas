/**
 * HTTP entry for the Mixpanel sync. Callers send `{ "mode": "incremental" | "weekly" | "rebuild" }`
 * and the shared secret header `x-mixpanel-sync-secret`. The one-time history load runs locally
 * (backfill.ts), not here.
 */

import { connect } from "./db.ts";
import { configFromEnv, Mixpanel } from "./mixpanel.ts";
import { storageFromEnv } from "./archive.ts";
import { type Mode, runMode } from "./sync.ts";

const MODES = new Set<Mode>(["incremental", "weekly", "rebuild"]);

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const expected = Deno.env.get("MIXPANEL_SYNC_SECRET") ?? "";
  const provided = request.headers.get("x-mixpanel-sync-secret") ?? "";
  if (!expected || !safeEqual(provided, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let mode: unknown;
  try {
    mode = ((await request.json()) as { mode?: unknown }).mode;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof mode !== "string" || !MODES.has(mode as Mode)) return Response.json({ error: "bad mode" }, { status: 400 });

  const sql = connect(Deno.env.get("MIXPANEL_DB_URL") ?? Deno.env.get("JIRA_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL"));
  try {
    const result = await runMode({
      sql,
      mp: new Mixpanel(configFromEnv()),
      storage: storageFromEnv(),
      log: (m) => console.log(m),
      budgetMs: 110_000,
    }, mode as Mode);
    return Response.json(result, { status: result.status === "error" ? 500 : 200 });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

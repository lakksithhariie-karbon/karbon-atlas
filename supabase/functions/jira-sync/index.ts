/**
 * HTTP entry for the Jira sync. Callers send `{ "mode": "backfill" | "incremental" | "nightly" | "rebuild" }`
 * and the shared secret header `x-jira-sync-secret`.
 */

import { runSync, type Mode } from "./sync.ts";

const MODES = new Set<Mode>(["backfill", "incremental", "nightly", "rebuild"]);

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

function isMode(value: unknown): value is Mode {
  return typeof value === "string" && MODES.has(value as Mode);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const expected = Deno.env.get("JIRA_SYNC_SECRET") ?? "";
  const provided = request.headers.get("x-jira-sync-secret") ?? "";
  if (!expected || !safeEqual(provided, expected)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let mode: unknown;
  try {
    const body = await request.json() as { mode?: unknown };
    mode = body.mode;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!isMode(mode)) return Response.json({ error: "bad mode" }, { status: 400 });
  const result = await runSync(mode);
  return Response.json(result, { status: result.status === "error" ? 500 : 200 });
});

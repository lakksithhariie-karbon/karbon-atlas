/**
 * The cleaned-event archive in the private Storage bucket `mixpanel-archive`: one gzipped JSON-lines
 * file per IST day, holding allowlisted fields only. Written with the service role key, which the Edge
 * runtime provides as SUPABASE_SERVICE_ROLE_KEY; the bucket has no policy for any other role.
 */

const BUCKET = "mixpanel-archive";

export interface StorageConfig {
  url: string;
  serviceKey: string;
}

export function storageFromEnv(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): StorageConfig {
  const url = get("SUPABASE_URL") ?? "";
  const serviceKey = get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) throw new Error("Storage credentials are not set");
  return { url: url.replace(/\/$/, ""), serviceKey };
}

export function archivePath(day: string): string {
  return `days/${day.slice(0, 4)}/${day}.jsonl.gz`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function headers(cfg: StorageConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.serviceKey}`, apikey: cfg.serviceKey };
}

/** Writes (or replaces) one day's file. Returns its path. */
export async function writeArchive(cfg: StorageConfig, day: string, lines: string): Promise<string> {
  const path = archivePath(day);
  const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...headers(cfg), "Content-Type": "application/gzip", "x-upsert": "true" },
    body: await gzip(lines),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`archive write ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await res.body?.cancel();
  return path;
}

export async function readArchive(cfg: StorageConfig, day: string): Promise<string> {
  const path = archivePath(day);
  const res = await fetch(`${cfg.url}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
    headers: headers(cfg),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`archive read ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await gunzip(await res.arrayBuffer());
}

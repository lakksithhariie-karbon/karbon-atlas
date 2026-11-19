/**
 * One lease per mode. A run that cannot take the lock is skipped.
 * An expired lease can be taken over.
 */

import type { Db } from "./db.ts";

const LEASE_SECONDS = 300;

export async function takeLease(db: Db, mode: string, owner: string): Promise<boolean> {
  const rows = await db.query<Array<{ owner: string }>>(
    `insert into ingest.jira_sync_lock (mode, owner, locked_until)
     values ($1, $2::uuid, now() + make_interval(secs => $3))
     on conflict (mode) do update set
       owner = excluded.owner,
       locked_until = excluded.locked_until
     where ingest.jira_sync_lock.locked_until <= now()
        or ingest.jira_sync_lock.owner = excluded.owner
     returning owner::text as owner`,
    [mode, owner, LEASE_SECONDS],
  );
  return rows.length > 0 && rows[0]?.owner === owner;
}

export async function releaseLease(db: Db, mode: string, owner: string): Promise<void> {
  await db.query(
    `delete from ingest.jira_sync_lock where mode = $1 and owner = $2::uuid`,
    [mode, owner],
  );
}

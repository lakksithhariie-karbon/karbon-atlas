# Jira sync runbook

The function is `jira-sync`. It accepts `POST` JSON `{ "mode": "backfill" | "incremental" | "nightly" | "rebuild" }` and the header `x-jira-sync-secret`. Migrations live in `supabase/migrations/`. Nothing here belongs in the Data API.

## Deploy

From the repo root, with `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` loaded:

```bash
npx -y supabase@2.72.7 functions deploy jira-sync \
  --project-ref "$SUPABASE_PROJECT_REF" \
  --use-api \
  --no-verify-jwt
```

If npm blocks the package's postinstall (it downloads the CLI binary), use the same version's
binary from the [Supabase CLI releases](https://github.com/supabase/cli/releases) with the same
arguments. `SUPABASE_PROJECT_REF` must be the bare ref, not the project URL. The CLI leaves
`supabase/.temp/`; delete it before committing.

Set the function secrets (values stay in the shell, not in a file):

- `JIRA_BASE_URL` — `https://karbonworks.atlassian.net`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_SYNC_SECRET` — a random shared secret
- `JIRA_DB_URL` — transaction pooler URI (`:6543`, user `postgres.<ref>`). The CLI refuses a secret named `SUPABASE_DB_URL`.

Store the same secret and the project URL in Vault so cron can call the function:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'jira_sync_project_url');
select vault.create_secret('<auth-secret>', 'jira_sync_auth_secret');
```

Apply `supabase/migrations/` in timestamp order. The last migration schedules the jobs. It does not overwrite a job that already exists.

## Backfill

Call the function until `done` is true. Each call saves its page token and stops after about 100 seconds.

```bash
curl -sS -X POST "$PROJECT_URL/functions/v1/jira-sync" \
  -H "Content-Type: application/json" \
  -H "x-jira-sync-secret: $JIRA_SYNC_SECRET" \
  -d '{"mode":"backfill"}'
```

A finished backfill stays finished. To run it again, delete the checkpoint:

```sql
delete from ingest.jira_sync_state where mode = 'backfill';
```

## Rebuild

Rebuild reads `ingest` and rewrites the clean tables. It does not call Jira.

```bash
curl -sS -X POST "$PROJECT_URL/functions/v1/jira-sync" \
  -H "Content-Type: application/json" \
  -H "x-jira-sync-secret: $JIRA_SYNC_SECRET" \
  -d '{"mode":"rebuild"}'
```

Call again while `done` is false.

## Pause and resume cron

```sql
select cron.alter_job(jobid, active := false)
from cron.job
where jobname in ('jira-sync-incremental', 'jira-sync-nightly');

select cron.alter_job(jobid, active := true)
from cron.job
where jobname in ('jira-sync-incremental', 'jira-sync-nightly');
```

`cron.alter_job` is the call that is allowed from the database API. A direct `update` of `cron.job` is rejected for that role.

`jira-sync-incremental` runs every 30 minutes. `jira-sync-nightly` runs at 20:30 UTC (02:00 IST).

## Health

```sql
select * from ingest.jira_sync_health;
```

`is_stale` is true when incremental has no successful run for 120 minutes, or nightly has none for 26 hours. `outdated_issues` is how many raw issues are still behind the published cleaning version. Recent runs are in `ingest.jira_sync_runs`.

## Cleaning version and the drain

`CURRENT_TRANSFORM_VERSION` lives in `supabase/functions/jira-sync/version.ts`. Bump that constant by 1 when a cleaning rule changes, then deploy the function. Do not edit stored rows by hand. The next invocation publishes the new version into `ingest.jira_cleaning_version`. After that, `outdated_issues` counts raw rows whose `transform_version` is lower.

Each incremental tick does its Jira work first. If that tick finishes inside the time budget, and no rebuild holds the rebuild lease, the rest of the budget re-cleans outdated raw issues in batches. That drain does not call Jira. It locks each batch with `select … for update` and writes the clean rows and the new version in one transaction. A partial incremental skips the drain. A manual rebuild is unchanged: it still walks every raw issue and holds the rebuild lease, which makes the drain wait for a later tick.

The run's `counts` include `recleaned` for a drain and, on a rebuild, `read_ms`, `transform_ms`, `write_ms`, and `payload_bytes`.

## Deletion guard

Nightly compares the number of issue ids Jira returned with the live rows in `f01_engineering.jira_issues` (`deleted_at is null`). Fewer than 90 percent and it does not set `deleted_at` on any issue. It still clears `deleted_at` on ids Jira did return. The run status stays `ok`. `warning` is text that starts with `deletion guard:` and includes both counts. `last_deletion_guard_at` on the health view is the finish time of the latest run with that warning. A null there means the guard has not tripped.

```sql
select finished_at, warning
from ingest.jira_sync_runs
where warning like 'deletion guard:%'
order by finished_at desc
limit 5;
```

## Rotate the Jira token

Create a new API token in Atlassian, then replace the function secret:

```bash
npx -y supabase@2.72.7 secrets set --project-ref "$SUPABASE_PROJECT_REF" \
  JIRA_API_TOKEN="$NEW_TOKEN"
```

Revoke the old token in Atlassian. The database does not store the token. No migration is required.

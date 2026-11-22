# Karbon Atlas data (Supabase)

Karbon-only. Not part of upstream Cloudflare OS.

This folder holds the database changes for the Karbon Atlas Supabase project (`karbon-os`).
Every schema, table, function and cron job is created by a migration file here, reviewed in a PR,
then applied. Nothing is changed by hand in the dashboard.

## Schemas

One schema per company function, named `f<NN>_<function>`. The number fixes the sort order, and
the leading letter means the name never needs quoting in SQL.

| Schema | Holds | Status |
|---|---|---|
| `f01_engineering` | Engineering data, starting with Jira project AiA (`SPEND`) | Jira tables and views |
| `f02_product` | Product usage from Mixpanel (Korefi Prod), from 2026-01-01, daily totals in India time, no personal data | Tables and module map; sync not built yet |

Raw source payloads and sync bookkeeping live in the private `ingest` schema. Cleaned Mixpanel events are archived, one gzipped file per India-time day, in the private Storage bucket `mixpanel-archive`. The Jira sync
function is `supabase/functions/jira-sync/`. Its runbook and design record are internal and kept
outside this public repo.

## Migrations

`migrations/<UTC timestamp>_<description>.sql`, in the Supabase CLI's format. Each migration is
written to be safe to run twice (`if not exists`, and so on). Some migrations are applied through
the Supabase Management API rather than the CLI, so the CLI's migration history may not list them.

## Tests

`tests/data_layer_reader_test.ts` checks, against the live database, that the Data Layer login
`karbon_data_reader` can read `f01_engineering` and `f02_product` and nothing else that matters. It needs
`DATA_LAYER_DATABASE_URL` in the root `.dev.vars`. Every write probe matches no rows or is rolled
back, and no row contents are printed.

```sh
deno test --config supabase/tests/deno.json --no-lock --allow-net --allow-env --allow-read supabase/tests/data_layer_reader_test.ts
```

## Secrets

Credentials live in `.secrets/.env` (git-ignored), never in this folder.

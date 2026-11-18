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
| `f01_engineering` | Engineering data, starting with Jira project AiA (`SPEND`) | Created, empty |

Raw source payloads and sync bookkeeping go in a separate private schema, not in the function
schemas. That schema doesn't exist yet.

## Migrations

`migrations/<UTC timestamp>_<description>.sql`, in the Supabase CLI's format. Each migration is
written to be safe to run twice (`if not exists`, and so on). Some migrations are applied through
the Supabase Management API rather than the CLI, so the CLI's migration history may not list them.

## Secrets

Credentials live in `.secrets/.env` (git-ignored), never in this folder.

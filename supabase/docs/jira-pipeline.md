# Jira → Supabase pipeline (AiA / SPEND)

Design record for syncing the Jira project **AiA** (key `SPEND`, id `10014`, site
`karbonworks.atlassian.net`) into the Supabase project `karbon-os`. Agreed 2026-11-18.

## Goals

- Clean, query-ready Jira data in `f01_engineering`, readable by people (Supabase dashboard) and agents (SQL).
- Reliable: idempotent, resumable, never two runs at once, failures visible.
- Everything inside Supabase: pg_cron → pg_net → Edge Function → Postgres.

## Flow

```
Jira Cloud (read-only)
   │
pg_cron ── every 30 min ──► jira-sync (mode=incremental)
        ── nightly 02:00 IST ► jira-sync (mode=nightly): reference data + deletion check
        ── manual ──────────► jira-sync (mode=backfill), resumable, called until done
   │
Edge Function jira-sync (Deno)
   take lease lock → read checkpoint → fetch → write raw → transform → upsert clean
   → save checkpoint → release lock → log run
   │
ingest            private: raw Jira JSON, sync state, run log, lock, health view
f01_engineering   clean tables + views
```

The function talks to Postgres directly (`SUPABASE_DB_URL`, one transaction per batch). Neither schema is
exposed through the Data API, and `anon` / `authenticated` get no grants.

## Jobs

| Mode | Schedule | Work |
|---|---|---|
| `backfill` | Manual, re-invoked until it reports `done` | Page `project = SPEND ORDER BY key ASC` (100/page) with `fields=*all`; for each page also fetch full comments, worklogs and changelogs. Saves its page token after every page. |
| `incremental` | `*/30 * * * *` | JQL `project = SPEND AND updated >= "<cursor − 15 min>" ORDER BY updated ASC`, the date formatted `yyyy-MM-dd HH:mm` in the Jira account's time zone (from `/myself`). Re-fetches comments, worklogs and changelogs of every returned issue. Cursor = max `updated` processed. |
| `nightly` | `30 20 * * *` UTC (02:00 IST) | Refresh reference data (fields, dropdown options, statuses, issue types, priorities, link types, boards, sprints). List every issue id in SPEND (`fields=id`); set `deleted_at` on issues no longer returned, clear it on any that reappear. |
| `rebuild` | Manual | Re-derive every clean table from `ingest` raw rows. No Jira calls. |

## Reliability rules

- **Lease lock** per job in `ingest.jira_sync_lock` (owner + expiry). A run that cannot take the lock exits with status `skipped`. Expired leases can be taken over.
- **Bounded work**: stop starting new pages after ~100 s of wall clock (Free plan limit 150 s; CPU 2 s/request; 256 MB). Save progress, return `{ done: false }`.
- **Idempotent**: every write is an upsert keyed by Jira id. Child sets per issue (comments, worklogs, links, attachments, sprint memberships) are replaced inside the issue's transaction, so deletions in Jira propagate.
- **Rate limits**: at most 4 concurrent Jira requests; honor `Retry-After` on 429 and back off with jitter on 5xx; slow down when `x-ratelimit-remaining` < 20.
- **Every run is logged** in `ingest.jira_sync_runs` (mode, start, end, status, counts, requests, error).
- **Health**: `ingest.jira_sync_health` reports minutes since the last successful run per mode and `is_stale` (incremental > 120 min, nightly > 26 h).

## Jira API notes (from the inventory)

- Search: `GET /rest/api/3/search/jql` with `nextPageToken` / `isLast`, no `total`. The old `/search` returns 410.
- Changelogs: `POST /rest/api/3/changelog/bulkfetch` (`issueIdsOrKeys`, paginated with `nextPageToken`). Verified on SPEND.
- Comments and worklogs are inlined in search but can be truncated: when `total` > returned, page the per-issue endpoint.
- Description and comment bodies are ADF (`type: doc`) even though the field catalog says string.
- All timestamps carry `+0530`. Store `timestamptz`.
- Counts: `POST /rest/api/3/search/approximate-count` (used for verification only).
- POST is used only for these two read endpoints. No Jira writes, ever.

## Schemas

### `ingest` (private)

| Table | Key | Contents |
|---|---|---|
| `jira_issue_raw` | `issue_id` | `issue_key`, `payload jsonb` (search payload, `fields=*all`), `jira_updated_at`, `fetched_at`, `deleted_at` |
| `jira_comment_raw` | `comment_id` | `issue_id`, `payload`, `fetched_at` |
| `jira_worklog_raw` | `worklog_id` | `issue_id`, `payload`, `fetched_at` |
| `jira_changelog_raw` | `history_id` | `issue_id`, `payload`, `fetched_at` |
| `jira_reference_raw` | `(kind, ref_id)` | fields, field options, statuses, issue types, priorities, link types, boards, sprints, myself (time zone only) |
| `jira_sync_state` | `mode` | `checkpoint jsonb`, `updated_at` |
| `jira_sync_runs` | `run_id` | `mode`, `started_at`, `finished_at`, `status` (`ok` / `partial` / `skipped` / `error`), counts, `requests`, `error` |
| `jira_sync_lock` | `mode` | `owner uuid`, `locked_until` |
| view `jira_sync_health` | | per mode: last success, minutes since, `is_stale` |

Raw rows drop nothing except emails: strip every `emailAddress` key before storing.

### `f01_engineering` (clean)

Tables are prefixed `jira_` so other engineering sources can sit beside them. Every table and column gets a
`COMMENT`. Every table has `synced_at timestamptz`.

| Table | Key | Columns |
|---|---|---|
| `jira_projects` | `project_id` | `project_key`, `name`, `project_type`, `style` |
| `jira_issues` | `issue_id` | see below |
| `jira_issue_types` | `issue_type_id` | `name`, `hierarchy_level`, `is_subtask` |
| `jira_statuses` | `status_id` | `name`, `category_key`, `category_name` |
| `jira_priorities` | `priority_id` | `name`, `sort_order` |
| `jira_teams` | `team_id` (text) | `name` |
| `jira_users` | `account_id` | `display_name`, `account_type`, `active`, `time_zone`. **No email.** |
| `jira_comments` | `comment_id` | `issue_id` → issues, `author_account_id`, `update_author_account_id`, `created_at`, `updated_at`, `body_text`, `body_adf jsonb`, `visibility jsonb` |
| `jira_issue_changes` | `(history_id, item_index)` | `issue_id` → issues, `author_account_id`, `changed_at`, `field`, `field_id`, `field_type`, `from_value`, `from_display`, `to_value`, `to_display` |
| `jira_worklogs` | `worklog_id` | `issue_id` → issues, `author_account_id`, `started_at`, `time_spent_seconds`, `created_at`, `updated_at`, `comment_text` |
| `jira_attachments` | `attachment_id` | `issue_id` → issues, `filename`, `mime_type`, `size_bytes`, `author_account_id`, `created_at`, `content_url`. Metadata only; files are never downloaded. |
| `jira_link_types` | `link_type_id` | `name`, `outward`, `inward` |
| `jira_issue_links` | `link_id` | `link_type_id`, `outward_issue_id`, `inward_issue_id`, `outward_issue_key`, `inward_issue_key` (no FK to issues: targets can be in other projects) |
| `jira_boards` | `board_id` | `name`, `board_type`, `location_project_id`, `filter_jql` |
| `jira_sprints` | `sprint_id` | `board_id` (nullable), `name`, `state`, `start_at`, `end_at`, `complete_at`, `goal` |
| `jira_issue_sprints` | `(issue_id, sprint_id)` | every sprint the issue was in |
| `jira_fields` | `field_id` | `jira_name`, `column_name`, `schema_type`, `is_custom`, `description` (filled in later by hand) |
| `jira_field_options` | `(field_id, option_id)` | `value`, `is_disabled` |

`jira_issues` columns:

| Group | Columns |
|---|---|
| Identity | `issue_id`, `issue_key` (unique), `project_id` |
| What | `summary`, `description_text`, `description_adf jsonb`, `issue_type_id`, `parent_issue_id` (indexed, no FK) |
| State | `status_id`, `resolution`, `priority_id`, `flagged boolean` |
| People | `assignee_account_id`, `reporter_account_id`, `creator_account_id`, `team_id` |
| Dates | `created_at`, `updated_at`, `resolved_at`, `status_changed_at`, `due_date date`, `start_date date` |
| Effort | `story_points numeric`, `original_estimate_seconds`, `remaining_estimate_seconds`, `time_spent_seconds` |
| Product area | `module` (cf 10832, dropdown, primary), `module_tags text[]` (cf 10585), `sub_module_tags text[]` (cf 10618), `feature` (cf 10833), `environment` (cf 10831, trimmed), `severity` (cf 10794, single value when one, else comma-joined), `root_cause_tags text[]` (cf 10796), `source_tags text[]` (cf 10795 ∪ 10797), `labels text[]` |
| Counts | `comment_count`, `attachment_count`, `watcher_count` |
| Sync | `synced_at`, `deleted_at` |

Foreign keys: from issues to the lookup tables, and from comments, changes, worklogs, attachments and
issue_sprints to issues. Not on `parent_issue_id` or links. User columns reference `jira_users`; insert
users before issues in the same transaction. GIN indexes on the `text[]` columns. Indexes on
`updated_at`, `status_id`, `assignee_account_id`, `parent_issue_id`.

Values are stored as Jira has them (trim whitespace only). No guessing merges such as `sycn` → `DataSync`.

### Views in `f01_engineering`

- `jira_issue_overview`: every non-deleted issue with type, status, status category, priority, team,
  assignee / reporter / creator names (`'Unassigned'` when null), parent key, and the product-area columns.
- `jira_tag_values`: `(field, value, issue_count)` for every tag-style column.

### ADF to text

`description_text`, `body_text` and `comment_text` hold the **complete** text, never truncated: paragraphs
and headings separated by blank lines, list items prefixed `- ` or `1. `, table rows as
`cell | cell`, links as `text (url)`, mentions as `@Display Name`, emoji as their text, code blocks kept,
media nodes as `[attachment: <filename or id>]`. The original ADF is kept beside it.

## Not in scope

Attachment files, Jira webhooks, other Jira projects, writing to Jira, custom-field descriptions (added by
hand later), alerting beyond the health view, Data API exposure, RLS, Cloudflare OS access, plan upgrades.

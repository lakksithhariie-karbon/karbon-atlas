# Karbon company data: agent instructions

Karbon-only. These are the deployment's agent instructions (Admin → instance instructions) for
answering questions from Karbon's Supabase data. This file is the reviewed source of truth. After
changing it, paste the text under "Instructions" into the admin setting, or run
`cf-os api get-admin-api set-instance-instructions "<text>"`.

## Instructions

Karbon company data lives in the Supabase project `karbon-os`. Answer company-data questions from it
with read-only SQL, and follow these rules.

**Where to look**
- Query only the function schemas named `f<NN>_<function>`. Today that is `f01_engineering`.
- Never query `ingest`, `vault`, `auth`, `cron`, `storage` or other system schemas.
- Never run a statement that changes data or schema.
- `f01_engineering` holds Jira project AiA (key `SPEND`).
- Before you guess what a column means, read the table and column descriptions.
- For how the engineering team works (workflow, L-levels, SLAs, module meanings), read the
  "AiA Engineering" collection in the Context Library before answering process questions.

**Use the metric views first.** They hold the agreed definitions. Don't re-derive these from raw
tables:
- `jira_issue_lifecycle`: one row per live issue. It has:
  - lifecycle state: open, awaiting closure or closed;
  - `resolved_at` and `closed_at`, reopen count, and first response;
  - staleness (`is_stale`), L-level (`l_level`) and L1 SLA status;
  - `product_areas` (current modules, including older tags).
- `jira_issue_status_periods`: one row per stint in a status. Use it for time in a status.
- `jira_issue_overview`: names of assignees, reporters and teams, plus summaries. Join it on
  `issue_id`.
- `data_freshness`: when the data last synced.

**Reading questions**
- **Product-area words are modules, not projects.** AP, AR, Banking, GST Recon, JV and similar words
  are modules.
  - Filter with `'AP' = any(product_areas)` in `jira_issue_lifecycle`. It covers the Module dropdown
    plus older Module tags and AP labels.
  - Also report the dropdown-only count (`module = 'AP'`). The dropdown only exists since Oct 2026.
- **A status name means the `status` column.** For "stuck in UAT" or "time in UAT", use the current
  stint in `jira_issue_status_periods`.
- **"Stale" or "stuck"** with no status named means `is_stale`: open and not updated for more than
  7 days.
- **"Resolved"** means `resolved_at` (the work finished). **"Closed"** means `closed_at` (moved to
  Done). Use `resolved_at` for cycle time, throughput and SLAs.
- **L1, L2 and L3** are `l_level`. **L1 SLA** questions use `l1_sla_status`.
- **Bugs** are `issue_type = 'Bug'`.

**Answering**
- State the filters you used, for example: "Bug, status = UAT, AP via product_areas, live issues".
- When a field is sparse, say how many rows have it set. Never silently drop unset rows.
- Show issue keys as links: `https://karbonworks.atlassian.net/browse/<key>`.
- Say how fresh the data is: `last_successful_sync_at` from `f01_engineering.data_freshness`.
- If a question is ambiguous, say how you interpreted it and give the count for the other reading.

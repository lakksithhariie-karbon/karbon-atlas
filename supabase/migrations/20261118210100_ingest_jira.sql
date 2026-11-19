-- Private raw Jira payloads, sync bookkeeping, and the health view.
-- anon and authenticated get no access. The Data API does not expose this schema.

create schema if not exists ingest;

comment on schema ingest is
  'Private Jira ingestion: raw payloads, checkpoints, run log, lease lock, and health. Not exposed through the Data API.';

create table if not exists ingest.jira_issue_raw (
  issue_id bigint primary key,
  issue_key text not null,
  payload jsonb not null,
  jira_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists ingest.jira_comment_raw (
  comment_id bigint primary key,
  issue_id bigint not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists ingest.jira_worklog_raw (
  worklog_id bigint primary key,
  issue_id bigint not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists ingest.jira_changelog_raw (
  history_id bigint primary key,
  issue_id bigint not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists ingest.jira_reference_raw (
  kind text not null,
  ref_id text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (kind, ref_id)
);

create table if not exists ingest.jira_sync_state (
  mode text primary key,
  checkpoint jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint jira_sync_state_mode_check check (mode in ('backfill', 'incremental', 'nightly', 'rebuild'))
);

create table if not exists ingest.jira_sync_runs (
  run_id uuid primary key default gen_random_uuid(),
  mode text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  counts jsonb not null default '{}'::jsonb,
  requests integer not null default 0,
  error text,
  constraint jira_sync_runs_mode_check check (mode in ('backfill', 'incremental', 'nightly', 'rebuild')),
  constraint jira_sync_runs_status_check check (status in ('ok', 'partial', 'skipped', 'error'))
);

create table if not exists ingest.jira_sync_lock (
  mode text primary key,
  owner uuid not null,
  locked_until timestamptz not null,
  constraint jira_sync_lock_mode_check check (mode in ('backfill', 'incremental', 'nightly', 'rebuild'))
);

create index if not exists jira_comment_raw_issue_id_idx on ingest.jira_comment_raw (issue_id);
create index if not exists jira_worklog_raw_issue_id_idx on ingest.jira_worklog_raw (issue_id);
create index if not exists jira_changelog_raw_issue_id_idx on ingest.jira_changelog_raw (issue_id);
create index if not exists jira_issue_raw_updated_idx on ingest.jira_issue_raw (jira_updated_at);
create index if not exists jira_sync_runs_mode_finished_idx on ingest.jira_sync_runs (mode, finished_at desc);

comment on table ingest.jira_issue_raw is
  'Search payload for one Jira issue, with every emailAddress key removed.';
comment on column ingest.jira_issue_raw.issue_id is
  'Jira issue id. Stable across a move; the primary key.';
comment on column ingest.jira_issue_raw.issue_key is
  'Issue key at fetch time, such as SPEND-1.';
comment on column ingest.jira_issue_raw.payload is
  'Issue object returned by search with fields=*all. emailAddress keys are removed.';
comment on column ingest.jira_issue_raw.jira_updated_at is
  'The issue updated timestamp from Jira.';
comment on column ingest.jira_issue_raw.fetched_at is
  'When this row was last written by a sync.';
comment on column ingest.jira_issue_raw.deleted_at is
  'When a nightly id scan no longer returned this issue. Null while the issue is in SPEND.';

comment on table ingest.jira_comment_raw is
  'One Jira comment payload. Replaced per issue on each sync of that issue.';
comment on column ingest.jira_comment_raw.comment_id is
  'Jira comment id.';
comment on column ingest.jira_comment_raw.issue_id is
  'Issue the comment belongs to.';
comment on column ingest.jira_comment_raw.payload is
  'Comment object with emailAddress keys removed.';
comment on column ingest.jira_comment_raw.fetched_at is
  'When this row was last written.';

comment on table ingest.jira_worklog_raw is
  'One Jira worklog payload. Replaced per issue on each sync of that issue.';
comment on column ingest.jira_worklog_raw.worklog_id is
  'Jira worklog id.';
comment on column ingest.jira_worklog_raw.issue_id is
  'Issue the worklog belongs to.';
comment on column ingest.jira_worklog_raw.payload is
  'Worklog object with emailAddress keys removed.';
comment on column ingest.jira_worklog_raw.fetched_at is
  'When this row was last written.';

comment on table ingest.jira_changelog_raw is
  'One Jira changelog history. Replaced per issue on each sync of that issue.';
comment on column ingest.jira_changelog_raw.history_id is
  'Jira changelog history id.';
comment on column ingest.jira_changelog_raw.issue_id is
  'Issue the history belongs to.';
comment on column ingest.jira_changelog_raw.payload is
  'History object with emailAddress keys removed.';
comment on column ingest.jira_changelog_raw.fetched_at is
  'When this row was last written.';

comment on table ingest.jira_reference_raw is
  'Catalog payloads: fields, options, statuses, issue types, priorities, link types, boards, sprints, the project, and the account time zone.';
comment on column ingest.jira_reference_raw.kind is
  'Catalog kind, such as field, status, board, sprint, or myself.';
comment on column ingest.jira_reference_raw.ref_id is
  'Id inside that kind. Field options use field id, a colon, then option id.';
comment on column ingest.jira_reference_raw.payload is
  'Jira object for that row, with emailAddress keys removed. myself stores only the time zone.';
comment on column ingest.jira_reference_raw.fetched_at is
  'When this row was last written.';

comment on table ingest.jira_sync_state is
  'Checkpoint for each sync mode so a run can resume after the time budget.';
comment on column ingest.jira_sync_state.mode is
  'backfill, incremental, nightly, or rebuild.';
comment on column ingest.jira_sync_state.checkpoint is
  'Mode-specific progress: page token, cursor, or rebuild offset.';
comment on column ingest.jira_sync_state.updated_at is
  'When the checkpoint was last saved.';

comment on table ingest.jira_sync_runs is
  'One row per invocation: status, counts, Jira request count, and a short error.';
comment on column ingest.jira_sync_runs.run_id is
  'Id of this invocation.';
comment on column ingest.jira_sync_runs.mode is
  'backfill, incremental, nightly, or rebuild.';
comment on column ingest.jira_sync_runs.started_at is
  'When the invocation started.';
comment on column ingest.jira_sync_runs.finished_at is
  'When the invocation finished. Null only if the process died first.';
comment on column ingest.jira_sync_runs.status is
  'ok, partial, skipped, or error.';
comment on column ingest.jira_sync_runs.counts is
  'Row counts written by this invocation, such as issues and comments.';
comment on column ingest.jira_sync_runs.requests is
  'Jira HTTP requests made by this invocation, including retries.';
comment on column ingest.jira_sync_runs.error is
  'Short failure text. Issue bodies and secrets are not stored here.';

comment on table ingest.jira_sync_lock is
  'Lease lock so only one run of a mode holds the job.';
comment on column ingest.jira_sync_lock.mode is
  'Mode the lease covers.';
comment on column ingest.jira_sync_lock.owner is
  'Invocation that holds the lease.';
comment on column ingest.jira_sync_lock.locked_until is
  'When the lease expires and another run may take it.';

create or replace view ingest.jira_sync_health as
with modes(mode) as (
  values ('backfill'::text), ('incremental'::text), ('nightly'::text), ('rebuild'::text)
),
last_success as (
  select mode, max(finished_at) as last_success_at
  from ingest.jira_sync_runs
  where status = 'ok'
  group by mode
)
select
  m.mode,
  s.last_success_at,
  case
    when s.last_success_at is null then null
    else floor(extract(epoch from (now() - s.last_success_at)) / 60)::integer
  end as minutes_since,
  case
    when m.mode = 'incremental' then
      s.last_success_at is null
      or now() - s.last_success_at > interval '120 minutes'
    when m.mode = 'nightly' then
      s.last_success_at is null
      or now() - s.last_success_at > interval '26 hours'
    else false
  end as is_stale
from modes m
left join last_success s on s.mode = m.mode;

comment on view ingest.jira_sync_health is
  'Minutes since the last successful run of each mode, and whether incremental or nightly is stale.';
comment on column ingest.jira_sync_health.mode is
  'backfill, incremental, nightly, or rebuild.';
comment on column ingest.jira_sync_health.last_success_at is
  'Finish time of the latest run whose status is ok. Null when that mode has never succeeded.';
comment on column ingest.jira_sync_health.minutes_since is
  'Whole minutes since last_success_at. Null when that mode has never succeeded.';
comment on column ingest.jira_sync_health.is_stale is
  'True when incremental has no success in 120 minutes, or nightly has no success in 26 hours.';

revoke all on schema ingest from public, anon, authenticated;
revoke all on all tables in schema ingest from public, anon, authenticated;
revoke all on all sequences in schema ingest from public, anon, authenticated;
revoke all on all functions in schema ingest from public, anon, authenticated;
alter default privileges in schema ingest revoke all on tables from public, anon, authenticated;
alter default privileges in schema ingest revoke all on sequences from public, anon, authenticated;
alter default privileges in schema ingest revoke all on functions from public, anon, authenticated;

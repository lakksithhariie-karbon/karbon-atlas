-- Private Mixpanel sync bookkeeping: run log, lease lock, per-day status, unknown fields, health.
-- No event data lives here; cleaned events are archived to the private Storage bucket
-- mixpanel-archive, and daily totals go to f02_product.
-- anon and authenticated get no access. The Data API does not expose this schema.

create schema if not exists ingest;

create table if not exists ingest.mixpanel_sync_runs (
  run_id uuid primary key default gen_random_uuid(),
  mode text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  first_day date,
  last_day date,
  counts jsonb not null default '{}'::jsonb,
  requests integer not null default 0,
  error text,
  constraint mixpanel_sync_runs_mode_check check (mode in ('backfill', 'incremental', 'weekly', 'rebuild')),
  constraint mixpanel_sync_runs_status_check check (status in ('running', 'ok', 'partial', 'skipped', 'error'))
);

create table if not exists ingest.mixpanel_sync_lock (
  lock_name text primary key,
  owner uuid not null,
  locked_until timestamptz not null
);

create table if not exists ingest.mixpanel_day_state (
  event_date date primary key,
  replaced_at timestamptz not null,
  run_id uuid,
  transform_version smallint not null,
  events integer not null,
  fact_rows integer not null,
  archive_path text,
  check_status text not null default 'not_checked',
  check_ours integer,
  check_mixpanel integer,
  check_detail jsonb,
  checked_at timestamptz,
  constraint mixpanel_day_state_check_status_check check (check_status in ('not_checked', 'match', 'mismatch', 'error'))
);

create table if not exists ingest.mixpanel_unknown_fields (
  event_name text not null,
  field_name text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences bigint not null default 0,
  decision text not null default 'pending',
  primary key (event_name, field_name),
  constraint mixpanel_unknown_fields_decision_check check (decision in ('pending', 'allowed', 'dropped'))
);

create index if not exists mixpanel_sync_runs_mode_finished_idx on ingest.mixpanel_sync_runs (mode, finished_at desc);

comment on table ingest.mixpanel_sync_runs is
  'One row per Mixpanel sync invocation: mode, IST days covered, status, counts, Mixpanel request count, short error.';
comment on column ingest.mixpanel_sync_runs.mode is 'backfill, incremental (every 2 hours), weekly (last 14 days), or rebuild (from the archive).';
comment on column ingest.mixpanel_sync_runs.status is 'running, ok, partial, skipped (lock held), or error.';
comment on column ingest.mixpanel_sync_runs.first_day is 'First IST day this run replaced.';
comment on column ingest.mixpanel_sync_runs.last_day is 'Last IST day this run replaced.';
comment on column ingest.mixpanel_sync_runs.counts is 'Counts written, such as events, fact_rows, inbox_events, users, companies.';
comment on column ingest.mixpanel_sync_runs.requests is 'Mixpanel HTTP requests made, including retries.';
comment on column ingest.mixpanel_sync_runs.error is 'Short failure text. No event data or secrets.';

comment on table ingest.mixpanel_sync_lock is 'Lease lock so only one Mixpanel run writes at a time (all modes share lock_name mixpanel).';
comment on column ingest.mixpanel_sync_lock.owner is 'run_id holding the lease.';
comment on column ingest.mixpanel_sync_lock.locked_until is 'When the lease expires and another run may take it.';

comment on table ingest.mixpanel_day_state is
  'One row per IST day: when it was last replaced, by which transform version, its archive file, and the count check against the Mixpanel Query API.';
comment on column ingest.mixpanel_day_state.event_date is 'IST day (Asia/Kolkata).';
comment on column ingest.mixpanel_day_state.transform_version is 'Cleaning code version that built this day. A bump triggers a rebuild from the archive.';
comment on column ingest.mixpanel_day_state.events is 'Distinct events (by $insert_id) in this day.';
comment on column ingest.mixpanel_day_state.fact_rows is 'Rows written to f02_product.mp_event_daily_facts for this day.';
comment on column ingest.mixpanel_day_state.archive_path is 'Object path of the cleaned, gzipped JSONL file in the mixpanel-archive bucket.';
comment on column ingest.mixpanel_day_state.check_status is 'not_checked, match, mismatch, or error.';
comment on column ingest.mixpanel_day_state.check_ours is 'Our event total for the day.';
comment on column ingest.mixpanel_day_state.check_mixpanel is 'Mixpanel Query API event total for the day.';
comment on column ingest.mixpanel_day_state.check_detail is 'Per-event differences when the totals do not match. Event names and counts only.';

comment on table ingest.mixpanel_unknown_fields is
  'Event properties that are not on the allowlist, so they were dropped. Names only, never values. Review and set decision.';
comment on column ingest.mixpanel_unknown_fields.decision is 'pending (not reviewed), allowed (add to the allowlist in code), or dropped (stay out).';

create or replace view ingest.mixpanel_sync_health as
with modes(mode, stale_after) as (
  values ('incremental'::text, interval '6 hours'), ('weekly'::text, interval '8 days')
),
last_success as (
  select mode, max(finished_at) as last_success_at
  from ingest.mixpanel_sync_runs
  where status = 'ok'
  group by mode
)
select
  m.mode,
  s.last_success_at,
  case when s.last_success_at is null then null
       else floor(extract(epoch from (now() - s.last_success_at)) / 60)::integer end as minutes_since,
  (s.last_success_at is null or now() - s.last_success_at > m.stale_after) as is_stale,
  (select count(*)::integer from ingest.mixpanel_day_state d
    where d.check_status in ('mismatch', 'error') and d.event_date >= current_date - 30) as days_failing_check_30d,
  (select count(*)::integer from ingest.mixpanel_unknown_fields f where f.decision = 'pending') as unknown_fields_pending
from modes m
left join last_success s on s.mode = m.mode;

comment on view ingest.mixpanel_sync_health is
  'Mixpanel sync health: minutes since the last successful incremental and weekly run, staleness (incremental 6 hours, weekly 8 days), days failing the count check in the last 30, and unreviewed unknown fields.';

revoke all on all tables in schema ingest from public, anon, authenticated;
revoke all on all sequences in schema ingest from public, anon, authenticated;

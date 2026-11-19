-- Cleaning-rule version, deletion-guard warning, and health columns.
-- Idempotent. anon and authenticated stay revoked.

alter table ingest.jira_issue_raw add column if not exists transform_version integer;

update ingest.jira_issue_raw
set transform_version = 1
where transform_version is null;

alter table ingest.jira_issue_raw alter column transform_version set default 1;
alter table ingest.jira_issue_raw alter column transform_version set not null;

comment on column ingest.jira_issue_raw.transform_version is
  'Cleaning-rule version stamped in the same transaction as the clean rows. Older values are re-cleaned from raw.';

create index if not exists jira_issue_raw_transform_version_idx
  on ingest.jira_issue_raw (transform_version, issue_id);

alter table ingest.jira_sync_runs add column if not exists warning text;

comment on column ingest.jira_sync_runs.warning is
  'Non-fatal notice. A deletion-guard trip starts with "deletion guard:". Null when the run had nothing to warn about.';

create table if not exists ingest.jira_cleaning_version (
  singleton boolean primary key default true check (singleton),
  version integer not null
);

comment on table ingest.jira_cleaning_version is
  'Version the deployed function last published. The health view counts raw issues below it.';
comment on column ingest.jira_cleaning_version.singleton is
  'Always true. Keeps the table to one row.';
comment on column ingest.jira_cleaning_version.version is
  'CURRENT_TRANSFORM_VERSION from the function. Raw rows below this are outdated.';

insert into ingest.jira_cleaning_version (singleton, version)
values (true, 1)
on conflict (singleton) do nothing;

comment on table ingest.jira_reference_raw is
  'Catalog payloads: fields, options, statuses, issue types, priorities, link types, boards, sprints, users, the project, and the account time zone.';
comment on column ingest.jira_reference_raw.kind is
  'Catalog kind, such as field, status, board, sprint, user, or myself.';

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
  end as is_stale,
  (
    select count(*)::integer
    from ingest.jira_issue_raw raw
    where raw.transform_version < (select version from ingest.jira_cleaning_version)
  ) as outdated_issues,
  (
    select max(finished_at)
    from ingest.jira_sync_runs
    where warning like 'deletion guard:%'
  ) as last_deletion_guard_at
from modes m
left join last_success s on s.mode = m.mode;

comment on view ingest.jira_sync_health is
  'Minutes since the last successful run of each mode, whether incremental or nightly is stale, how many raw issues are behind the cleaning version, and the last deletion-guard trip.';
comment on column ingest.jira_sync_health.mode is
  'backfill, incremental, nightly, or rebuild.';
comment on column ingest.jira_sync_health.last_success_at is
  'Finish time of the latest run whose status is ok. Null when that mode has never succeeded.';
comment on column ingest.jira_sync_health.minutes_since is
  'Whole minutes since last_success_at. Null when that mode has never succeeded.';
comment on column ingest.jira_sync_health.is_stale is
  'True when incremental has no success in 120 minutes, or nightly has no success in 26 hours.';
comment on column ingest.jira_sync_health.outdated_issues is
  'Raw issues whose transform_version is below the published cleaning version.';
comment on column ingest.jira_sync_health.last_deletion_guard_at is
  'Finish time of the latest run whose warning records a deletion-guard trip. Null when the guard has never tripped.';

revoke all on table ingest.jira_cleaning_version from public, anon, authenticated;

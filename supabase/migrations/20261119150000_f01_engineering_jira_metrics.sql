-- Metric layer for the Jira data in f01_engineering: agreed definitions computed once, so agents and
-- people read the same numbers instead of re-deriving them in ad-hoc SQL.
--
-- Definitions (agreed with the owner 2026-11-19):
--   * Resolved  = the issue last entered a status in the "done" category (Issue Resolved or Done) from
--                 an open status. Closed = it last moved into a status named Done.
--   * Reopened  = a move from a done-category status back to an open one.
--   * L-levels  = priority levels: Highest = L1, High = L2, Medium = L3; a Severity of L1/L2/L3, when
--                 set and more severe, wins. L1 must be resolved within 3 days of creation, every
--                 issue type, calendar time.
--   * Stale     = open, and not updated in Jira for more than 7 days (Blocked/Onhold included).
--   * First response = the first comment by someone other than the reporter.
--   * Product area = the Module dropdown, plus older Module tags and AP labels mapped to today's
--                    modules through jira_area_map.
--
-- Idempotent. No grants to anon or authenticated (the schema's default privileges already revoke).

-- --------------------------------------------------------------------------------------------------
-- Mapping of older Module tags and labels to today's Module and Feature values.

create table if not exists f01_engineering.jira_area_map (
  source text not null check (source in ('module_tag', 'label')),
  tag text not null,
  module text,
  feature text,
  note text,
  primary key (source, tag)
);

comment on table f01_engineering.jira_area_map is
  'Maps older Module tags (customfield_10585) and labels to today''s Module dropdown values and Feature values. Maintained by migration from owner decisions; tag is matched case-insensitively.';
comment on column f01_engineering.jira_area_map.source is 'Where the tag comes from: module_tag (older multi-value Module field) or label.';
comment on column f01_engineering.jira_area_map.tag is 'The tag in lower case.';
comment on column f01_engineering.jira_area_map.module is 'Current Module dropdown value it maps to, or null when the tag names a feature only.';
comment on column f01_engineering.jira_area_map.feature is 'Current Feature dropdown value it maps to, when the tag names a feature.';
comment on column f01_engineering.jira_area_map.note is 'What the tag means, in words.';

insert into f01_engineering.jira_area_map (source, tag, module, feature, note) values
  ('module_tag', 'ap', 'AP', null, null),
  ('module_tag', 'inbox', 'AP', null, 'AP inbox'),
  ('module_tag', 'purchase', 'AP', null, null),
  ('module_tag', 'ar', 'AR', null, null),
  ('module_tag', 'banking', 'Banking/Transaction', null, null),
  ('module_tag', 'bank', 'Banking/Transaction', null, null),
  ('module_tag', 'transactions', 'Banking/Transaction', null, null),
  ('module_tag', 'gstrecon', 'GST Recon', null, null),
  ('module_tag', 'dashboard', 'Dashboard', null, null),
  ('module_tag', 'jv', 'JV', null, null),
  ('module_tag', 'generic', 'Generic', null, null),
  ('module_tag', 'login/signup', 'Login/Application', null, null),
  ('module_tag', 'aiabot', null, 'Bot', 'WhatsApp Bot'),
  ('module_tag', 'sync', null, 'Sync/Integration', 'Tally sync'),
  ('module_tag', 'integration', null, 'Sync/Integration', 'Tally integration'),
  ('module_tag', 'zohobilling', null, 'Billing Management', 'Subscription management'),
  ('module_tag', 'application', 'Generic', null, null),
  ('module_tag', 'masters', 'Generic', null, null),
  ('module_tag', 'coa', 'Generic', null, null),
  ('module_tag', 'configuration', 'Generic', null, null),
  ('module_tag', 'onboarding', 'Generic', null, null),
  ('module_tag', 'self-onboarding', 'Generic', null, null),
  ('module_tag', 'multi-user', 'Generic', null, null),
  ('module_tag', 'rbac', 'Generic', null, null),
  ('module_tag', 'model', 'Generic', null, null),
  ('module_tag', 'cn/dn', 'Generic', null, null),
  ('module_tag', 'data', 'Generic', null, null),
  ('module_tag', 'na', 'Generic', null, null),
  ('module_tag', 'api', 'Generic', null, null),
  ('module_tag', 'ui', 'Generic', null, null),
  ('module_tag', 'ai_txn', 'Generic', null, null),
  ('module_tag', 'inventory', 'Generic', null, null),
  ('module_tag', 'upload', 'Generic', null, null),
  ('module_tag', 'report', 'Generic', null, null),
  ('module_tag', 'aia_connector', 'Generic', null, null),
  ('label', 'ap', 'AP', null, null),
  ('label', 'ai_ap', 'AP', null, null),
  ('label', 'historicaldata_ap', 'AP', null, 'AP historical data')
on conflict (source, tag) do update set
  module = excluded.module, feature = excluded.feature, note = excluded.note;

-- --------------------------------------------------------------------------------------------------
-- One row per stint of an issue in a status, from the changelog.

create or replace view f01_engineering.jira_issue_status_periods as
with moves as (
  select
    c.issue_id,
    c.changed_at,
    c.from_value::bigint as from_status_id,
    c.to_value::bigint as to_status_id,
    row_number() over (partition by c.issue_id order by c.changed_at, c.history_id, c.item_index) as seq
  from f01_engineering.jira_issue_changes c
  where c.field = 'status' and c.changed_at is not null
),
periods as (
  -- The status an issue was created in, until its first move.
  select i.issue_id, m.from_status_id as status_id, i.created_at as entered_at, m.changed_at as left_at
  from f01_engineering.jira_issues i
  join moves m on m.issue_id = i.issue_id and m.seq = 1
  union all
  -- Each move starts a stint that lasts until the next move (or is still running).
  select m.issue_id, m.to_status_id, m.changed_at,
         lead(m.changed_at) over (partition by m.issue_id order by m.seq)
  from moves m
  union all
  -- Issues that never changed status: one stint since creation.
  select i.issue_id, i.status_id, i.created_at, null
  from f01_engineering.jira_issues i
  where not exists (select 1 from moves m where m.issue_id = i.issue_id)
)
select
  p.issue_id,
  i.issue_key,
  s.name as status,
  s.category_key as status_category,
  p.entered_at,
  p.left_at,
  p.left_at is null as is_current,
  coalesce(p.left_at, now()) - p.entered_at as duration
from periods p
join f01_engineering.jira_issues i on i.issue_id = p.issue_id
left join f01_engineering.jira_statuses s on s.status_id = p.status_id
where i.deleted_at is null;

comment on view f01_engineering.jira_issue_status_periods is
  'One row per stint of a live issue in a status, from the status changelog. Use for time in status: the current stint is is_current; duration runs to now for it.';
comment on column f01_engineering.jira_issue_status_periods.issue_id is 'Jira issue id.';
comment on column f01_engineering.jira_issue_status_periods.issue_key is 'Jira issue key, e.g. SPEND-123.';
comment on column f01_engineering.jira_issue_status_periods.status is 'Status name during this stint.';
comment on column f01_engineering.jira_issue_status_periods.status_category is 'Status category key: new, indeterminate or done.';
comment on column f01_engineering.jira_issue_status_periods.entered_at is 'When the issue entered the status (creation time for the first stint).';
comment on column f01_engineering.jira_issue_status_periods.left_at is 'When it left the status; null while it is still there.';
comment on column f01_engineering.jira_issue_status_periods.is_current is 'True for the stint the issue is in now.';
comment on column f01_engineering.jira_issue_status_periods.duration is 'Time in the status for this stint, up to now for the current stint.';

-- --------------------------------------------------------------------------------------------------
-- One row per live issue with the agreed lifecycle metrics.

create or replace view f01_engineering.jira_issue_lifecycle as
with status_moves as (
  select
    c.issue_id,
    c.changed_at,
    fs.category_key as from_category,
    ts.category_key as to_category,
    ts.name as to_name
  from f01_engineering.jira_issue_changes c
  left join f01_engineering.jira_statuses fs on fs.status_id = c.from_value::bigint
  left join f01_engineering.jira_statuses ts on ts.status_id = c.to_value::bigint
  where c.field = 'status' and c.changed_at is not null
),
move_stats as (
  select
    issue_id,
    max(changed_at) filter (where to_category = 'done' and coalesce(from_category, '') <> 'done') as last_resolved_at,
    max(changed_at) filter (where to_name = 'Done') as last_closed_at,
    count(*) filter (where from_category = 'done' and to_category <> 'done') as reopen_count
  from status_moves
  group by issue_id
),
first_response as (
  select c.issue_id, min(c.created_at) as first_response_at
  from f01_engineering.jira_comments c
  join f01_engineering.jira_issues i on i.issue_id = c.issue_id
  where c.author_account_id is distinct from i.reporter_account_id
  group by c.issue_id
),
areas as (
  select x.issue_id, array_agg(distinct x.module order by x.module) filter (where x.module is not null) as modules,
         array_agg(distinct x.feature order by x.feature) filter (where x.feature is not null) as features
  from (
    select i.issue_id, i.module, i.feature from f01_engineering.jira_issues i
    union all
    select i.issue_id, m.module, m.feature
    from f01_engineering.jira_issues i
    cross join lateral unnest(coalesce(i.module_tags, '{}')) t(tag)
    join f01_engineering.jira_area_map m on m.source = 'module_tag' and m.tag = lower(t.tag)
    union all
    select i.issue_id, m.module, m.feature
    from f01_engineering.jira_issues i
    cross join lateral unnest(coalesce(i.labels, '{}')) t(tag)
    join f01_engineering.jira_area_map m on m.source = 'label' and m.tag = lower(t.tag)
  ) x
  group by x.issue_id
),
base as (
  select
    i.issue_id,
    i.issue_key,
    it.name as issue_type,
    s.name as status,
    s.category_key as status_category,
    p.name as priority,
    i.severity,
    i.created_at,
    i.updated_at,
    i.reporter_account_id,
    i.assignee_account_id,
    i.module,
    a.modules as product_areas,
    a.features as feature_areas,
    least(
      case p.name when 'Highest' then 1 when 'High' then 2 when 'Medium' then 3 end,
      case when i.severity like '%L1%' then 1 when i.severity like '%L2%' then 2 when i.severity like '%L3%' then 3 end
    ) as l_level_number,
    -- Without a resolving move in the changelog, fall back to Jira's own "entered the done category"
    -- time (statuscategorychangedate), then the resolution date.
    case when s.category_key = 'done' then coalesce(ms.last_resolved_at, i.status_changed_at, i.resolved_at) end as resolved_at,
    case when s.name = 'Done' then coalesce(ms.last_closed_at, ms.last_resolved_at, i.status_changed_at, i.resolved_at) end as closed_at,
    coalesce(ms.reopen_count, 0) as reopen_count,
    fr.first_response_at
  from f01_engineering.jira_issues i
  left join f01_engineering.jira_issue_types it on it.issue_type_id = i.issue_type_id
  left join f01_engineering.jira_statuses s on s.status_id = i.status_id
  left join f01_engineering.jira_priorities p on p.priority_id = i.priority_id
  left join move_stats ms on ms.issue_id = i.issue_id
  left join first_response fr on fr.issue_id = i.issue_id
  left join areas a on a.issue_id = i.issue_id
  where i.deleted_at is null
)
select
  b.issue_id,
  b.issue_key,
  b.issue_type,
  b.status,
  b.status_category,
  case
    when b.status_category <> 'done' then 'open'
    when b.status = 'Done' then 'closed'
    else 'awaiting_closure'
  end as lifecycle_state,
  b.status_category <> 'done' as is_open,
  b.priority,
  b.severity,
  'L' || b.l_level_number as l_level,
  b.module,
  b.product_areas,
  b.feature_areas,
  b.created_at,
  b.updated_at,
  b.resolved_at,
  b.closed_at,
  b.resolved_at - b.created_at as time_to_resolve,
  b.reopen_count,
  b.first_response_at,
  b.first_response_at - b.created_at as time_to_first_response,
  now() - b.updated_at as time_since_update,
  b.status_category <> 'done' and b.updated_at < now() - interval '7 days' as is_stale,
  case when b.l_level_number = 1 then b.created_at + interval '3 days' end as l1_sla_due_at,
  case
    when b.l_level_number is distinct from 1 then null
    when b.status_category <> 'done' and now() <= b.created_at + interval '3 days' then 'open_within'
    when b.status_category <> 'done' then 'open_breaching'
    when b.resolved_at is null then null
    when b.resolved_at <= b.created_at + interval '3 days' then 'met'
    else 'breached'
  end as l1_sla_status
from base b;

comment on view f01_engineering.jira_issue_lifecycle is
  'One row per live issue with the agreed delivery metrics: lifecycle state, resolved and closed times, reopens, L-level and L1 SLA, first response, staleness and product area. Use this instead of re-deriving these from the changelog.';
comment on column f01_engineering.jira_issue_lifecycle.issue_id is 'Jira issue id.';
comment on column f01_engineering.jira_issue_lifecycle.issue_key is 'Jira issue key, e.g. SPEND-123. Link: https://karbonworks.atlassian.net/browse/<key>.';
comment on column f01_engineering.jira_issue_lifecycle.issue_type is 'Issue type name: Bug, Task, Story, Improvement, Epic, Subtask, Feature, …';
comment on column f01_engineering.jira_issue_lifecycle.status is 'Current status name.';
comment on column f01_engineering.jira_issue_lifecycle.status_category is 'Current status category key: new, indeterminate or done.';
comment on column f01_engineering.jira_issue_lifecycle.lifecycle_state is 'open (not finished), awaiting_closure (Issue Resolved: finished, QA has not closed it) or closed (Done).';
comment on column f01_engineering.jira_issue_lifecycle.is_open is 'True when the work is not finished (status category is not done). Blocked/Onhold counts as open.';
comment on column f01_engineering.jira_issue_lifecycle.priority is 'Jira priority name.';
comment on column f01_engineering.jira_issue_lifecycle.severity is 'Severity field (L1/L2/L3), often empty.';
comment on column f01_engineering.jira_issue_lifecycle.l_level is 'L1, L2 or L3. L-levels are priority levels: Highest = L1, High = L2, Medium = L3; a more severe Severity value wins. Null for Low/Lowest without a Severity.';
comment on column f01_engineering.jira_issue_lifecycle.module is 'Module dropdown value (in use since Oct 2026).';
comment on column f01_engineering.jira_issue_lifecycle.product_areas is 'Every current Module the issue belongs to: the dropdown plus older Module tags and AP labels mapped through jira_area_map. Filter with ''AP'' = any(product_areas). Null when nothing maps.';
comment on column f01_engineering.jira_issue_lifecycle.feature_areas is 'Feature values: the Feature dropdown plus older tags that name a feature (AiABot → Bot, sync/Integration → Sync/Integration, ZohoBilling → Billing Management).';
comment on column f01_engineering.jira_issue_lifecycle.created_at is 'When the issue was raised.';
comment on column f01_engineering.jira_issue_lifecycle.updated_at is 'Last update of any kind in Jira.';
comment on column f01_engineering.jira_issue_lifecycle.resolved_at is 'When the work was finished: the latest move into Issue Resolved or Done from an open status. Null while open. Use this, not closed_at, for cycle time, throughput and SLAs.';
comment on column f01_engineering.jira_issue_lifecycle.closed_at is 'When the issue last moved to Done (QA closure). Often days after resolved_at, sometimes in bulk sweeps; use only for closure counts.';
comment on column f01_engineering.jira_issue_lifecycle.time_to_resolve is 'resolved_at minus created_at.';
comment on column f01_engineering.jira_issue_lifecycle.reopen_count is 'How many times the issue moved from Issue Resolved or Done back to an open status.';
comment on column f01_engineering.jira_issue_lifecycle.first_response_at is 'First comment by someone other than the reporter.';
comment on column f01_engineering.jira_issue_lifecycle.time_to_first_response is 'first_response_at minus created_at.';
comment on column f01_engineering.jira_issue_lifecycle.time_since_update is 'now() minus updated_at.';
comment on column f01_engineering.jira_issue_lifecycle.is_stale is 'Open and not updated in Jira for more than 7 days.';
comment on column f01_engineering.jira_issue_lifecycle.l1_sla_due_at is 'For L1: created_at + 3 days (calendar). Null otherwise.';
comment on column f01_engineering.jira_issue_lifecycle.l1_sla_status is 'For L1 only: met, breached, open_within (open, still inside 3 days) or open_breaching (open, past 3 days). Applies to every issue type.';

-- --------------------------------------------------------------------------------------------------
-- How fresh the data is, without exposing the private ingest schema.

create or replace view f01_engineering.data_freshness as
select
  'jira'::text as source,
  (select max(synced_at) from f01_engineering.jira_issues) as last_synced_at,
  (select max(finished_at) from ingest.jira_sync_runs where mode = 'incremental' and status = 'ok') as last_successful_sync_at,
  (select coalesce(bool_or(is_stale), true) from ingest.jira_sync_health where mode in ('incremental', 'nightly')) as is_stale;

comment on view f01_engineering.data_freshness is
  'When each source in this schema was last synced. Quote last_successful_sync_at in answers. Reads the private sync log on the reader''s behalf.';
comment on column f01_engineering.data_freshness.source is 'Data source name.';
comment on column f01_engineering.data_freshness.last_synced_at is 'Latest synced_at on any issue row.';
comment on column f01_engineering.data_freshness.last_successful_sync_at is 'When the last successful 30-minute incremental sync finished.';
comment on column f01_engineering.data_freshness.is_stale is 'True when the incremental sync is more than 2 hours late or the nightly sync more than 26 hours late.';

revoke all on f01_engineering.jira_area_map, f01_engineering.jira_issue_status_periods,
  f01_engineering.jira_issue_lifecycle, f01_engineering.data_freshness from public, anon, authenticated;

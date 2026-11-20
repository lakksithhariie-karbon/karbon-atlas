-- The status each live issue is in now, and since when, without rebuilding every status stint.
--
-- `jira_issue_status_periods` numbers every status move of every issue with window functions, so a
-- question about current stints ("which bugs are stuck in UAT?") pays for all ~30,000 stints before
-- any filter applies (about 23 s). This view finds each issue's latest status move through a
-- partial index instead.
--
-- Not `jira_issues.status_changed_at`: that is Jira's `statuscategorychangedate`, which moves only
-- when the status *category* changes, so it stays put across In Progress -> Code Review -> UAT.
--
-- Idempotent: safe to run again.

create index if not exists jira_issue_changes_status_idx
  on f01_engineering.jira_issue_changes (issue_id, changed_at desc, history_id desc, item_index desc)
  where field = 'status' and changed_at is not null;

comment on index f01_engineering.jira_issue_changes_status_idx is
  'Latest status move per issue, for jira_issue_current_status.';

-- The same stint as jira_issue_status_periods where is_current: the target of the latest status
-- move (ordered like that view, by changed_at, history_id, item_index), or, for an issue that
-- never moved, its status since creation.
create or replace view f01_engineering.jira_issue_current_status as
select
  i.issue_id,
  i.issue_key,
  s.name as status,
  s.category_key as status_category,
  coalesce(m.changed_at, i.created_at) as entered_at,
  now() - coalesce(m.changed_at, i.created_at) as duration
from f01_engineering.jira_issues i
left join lateral (
  select c.changed_at, c.to_value::bigint as to_status_id
  from f01_engineering.jira_issue_changes c
  where c.issue_id = i.issue_id and c.field = 'status' and c.changed_at is not null
  order by c.changed_at desc, c.history_id desc, c.item_index desc
  limit 1
) m on true
left join f01_engineering.jira_statuses s on s.status_id = coalesce(m.to_status_id, i.status_id)
where i.deleted_at is null;

comment on view f01_engineering.jira_issue_current_status is
  'One row per live issue: the status it is in now and how long it has been there. Same as jira_issue_status_periods where is_current, but fast. Use it for "stuck in <status>" and "time in current status" questions.';
comment on column f01_engineering.jira_issue_current_status.issue_id is 'Jira issue id.';
comment on column f01_engineering.jira_issue_current_status.issue_key is 'Jira issue key, e.g. SPEND-123.';
comment on column f01_engineering.jira_issue_current_status.status is 'Status the issue is in now.';
comment on column f01_engineering.jira_issue_current_status.status_category is 'Status category key: new, indeterminate or done.';
comment on column f01_engineering.jira_issue_current_status.entered_at is 'When the issue entered its current status (creation time if it never moved).';
comment on column f01_engineering.jira_issue_current_status.duration is 'Time in the current status, up to now.';

-- Default privileges already grant new f01_engineering views to ro_f01_engineering; this keeps a
-- re-run on a database created before them correct too.
grant select on f01_engineering.jira_issue_current_status to ro_f01_engineering;

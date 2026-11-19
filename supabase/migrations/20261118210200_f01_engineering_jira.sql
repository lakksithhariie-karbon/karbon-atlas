-- Clean Jira tables for project AiA (SPEND). Every table and column is commented.
-- anon and authenticated get no access. The Data API does not expose this schema.

create schema if not exists f01_engineering;

comment on schema f01_engineering is
  'Engineering function data. Clean, query-ready tables only; raw payloads and sync state live in ingest.';

create table if not exists f01_engineering.jira_projects (
  project_id bigint primary key,
  project_key text not null,
  name text,
  project_type text,
  style text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_issue_types (
  issue_type_id bigint primary key,
  name text,
  hierarchy_level integer,
  is_subtask boolean,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_statuses (
  status_id bigint primary key,
  name text,
  category_key text,
  category_name text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_priorities (
  priority_id bigint primary key,
  name text,
  sort_order integer,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_teams (
  team_id text primary key,
  name text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_users (
  account_id text primary key,
  display_name text,
  account_type text,
  active boolean,
  time_zone text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_issues (
  issue_id bigint primary key,
  issue_key text not null unique,
  project_id bigint not null,
  summary text,
  description_text text,
  description_adf jsonb,
  issue_type_id bigint not null,
  parent_issue_id bigint,
  status_id bigint not null,
  resolution text,
  priority_id bigint,
  flagged boolean not null default false,
  assignee_account_id text,
  reporter_account_id text,
  creator_account_id text,
  team_id text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  status_changed_at timestamptz,
  due_date date,
  start_date date,
  story_points numeric,
  original_estimate_seconds bigint,
  remaining_estimate_seconds bigint,
  time_spent_seconds bigint,
  module text,
  module_tags text[],
  sub_module_tags text[],
  feature text,
  environment text,
  severity text,
  root_cause_tags text[],
  source_tags text[],
  labels text[],
  comment_count integer,
  attachment_count integer,
  watcher_count integer,
  synced_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists f01_engineering.jira_comments (
  comment_id bigint primary key,
  issue_id bigint not null,
  author_account_id text,
  update_author_account_id text,
  created_at timestamptz,
  updated_at timestamptz,
  body_text text,
  body_adf jsonb,
  visibility jsonb,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_issue_changes (
  history_id bigint not null,
  item_index integer not null,
  issue_id bigint not null,
  author_account_id text,
  changed_at timestamptz,
  field text,
  field_id text,
  field_type text,
  from_value text,
  from_display text,
  to_value text,
  to_display text,
  synced_at timestamptz not null default now(),
  primary key (history_id, item_index)
);

create table if not exists f01_engineering.jira_worklogs (
  worklog_id bigint primary key,
  issue_id bigint not null,
  author_account_id text,
  started_at timestamptz,
  time_spent_seconds bigint,
  created_at timestamptz,
  updated_at timestamptz,
  comment_text text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_attachments (
  attachment_id bigint primary key,
  issue_id bigint not null,
  filename text,
  mime_type text,
  size_bytes bigint,
  author_account_id text,
  created_at timestamptz,
  content_url text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_link_types (
  link_type_id bigint primary key,
  name text,
  outward text,
  inward text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_issue_links (
  link_id bigint primary key,
  link_type_id bigint,
  outward_issue_id bigint,
  inward_issue_id bigint,
  outward_issue_key text,
  inward_issue_key text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_boards (
  board_id bigint primary key,
  name text,
  board_type text,
  location_project_id bigint,
  filter_jql text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_sprints (
  sprint_id bigint primary key,
  board_id bigint,
  name text,
  state text,
  start_at timestamptz,
  end_at timestamptz,
  complete_at timestamptz,
  goal text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_issue_sprints (
  issue_id bigint not null,
  sprint_id bigint not null,
  synced_at timestamptz not null default now(),
  primary key (issue_id, sprint_id)
);

create table if not exists f01_engineering.jira_fields (
  field_id text primary key,
  jira_name text,
  column_name text,
  schema_type text,
  is_custom boolean,
  description text,
  synced_at timestamptz not null default now()
);

create table if not exists f01_engineering.jira_field_options (
  field_id text not null,
  option_id text not null,
  value text,
  is_disabled boolean,
  synced_at timestamptz not null default now(),
  primary key (field_id, option_id)
);

create index if not exists jira_issues_updated_at_idx on f01_engineering.jira_issues (updated_at);
create index if not exists jira_issues_status_id_idx on f01_engineering.jira_issues (status_id);
create index if not exists jira_issues_assignee_account_id_idx on f01_engineering.jira_issues (assignee_account_id);
create index if not exists jira_issues_parent_issue_id_idx on f01_engineering.jira_issues (parent_issue_id);
create index if not exists jira_issues_labels_idx on f01_engineering.jira_issues using gin (labels);
create index if not exists jira_issues_module_tags_idx on f01_engineering.jira_issues using gin (module_tags);
create index if not exists jira_issues_sub_module_tags_idx on f01_engineering.jira_issues using gin (sub_module_tags);
create index if not exists jira_issues_root_cause_tags_idx on f01_engineering.jira_issues using gin (root_cause_tags);
create index if not exists jira_issues_source_tags_idx on f01_engineering.jira_issues using gin (source_tags);
create index if not exists jira_comments_issue_id_idx on f01_engineering.jira_comments (issue_id);
create index if not exists jira_issue_changes_issue_id_idx on f01_engineering.jira_issue_changes (issue_id);
create index if not exists jira_worklogs_issue_id_idx on f01_engineering.jira_worklogs (issue_id);
create index if not exists jira_attachments_issue_id_idx on f01_engineering.jira_attachments (issue_id);
create index if not exists jira_issue_links_outward_idx on f01_engineering.jira_issue_links (outward_issue_id);
create index if not exists jira_issue_links_inward_idx on f01_engineering.jira_issue_links (inward_issue_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_project_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_project_id_fkey foreign key (project_id) references f01_engineering.jira_projects (project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_issue_type_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_issue_type_id_fkey foreign key (issue_type_id) references f01_engineering.jira_issue_types (issue_type_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_status_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_status_id_fkey foreign key (status_id) references f01_engineering.jira_statuses (status_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_priority_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_priority_id_fkey foreign key (priority_id) references f01_engineering.jira_priorities (priority_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_assignee_account_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_assignee_account_id_fkey foreign key (assignee_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_reporter_account_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_reporter_account_id_fkey foreign key (reporter_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_creator_account_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_creator_account_id_fkey foreign key (creator_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issues_team_id_fkey') then
    alter table f01_engineering.jira_issues
      add constraint jira_issues_team_id_fkey foreign key (team_id) references f01_engineering.jira_teams (team_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_comments_issue_id_fkey') then
    alter table f01_engineering.jira_comments
      add constraint jira_comments_issue_id_fkey foreign key (issue_id) references f01_engineering.jira_issues (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_comments_author_account_id_fkey') then
    alter table f01_engineering.jira_comments
      add constraint jira_comments_author_account_id_fkey foreign key (author_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_comments_update_author_account_id_fkey') then
    alter table f01_engineering.jira_comments
      add constraint jira_comments_update_author_account_id_fkey foreign key (update_author_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issue_changes_issue_id_fkey') then
    alter table f01_engineering.jira_issue_changes
      add constraint jira_issue_changes_issue_id_fkey foreign key (issue_id) references f01_engineering.jira_issues (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issue_changes_author_account_id_fkey') then
    alter table f01_engineering.jira_issue_changes
      add constraint jira_issue_changes_author_account_id_fkey foreign key (author_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_worklogs_issue_id_fkey') then
    alter table f01_engineering.jira_worklogs
      add constraint jira_worklogs_issue_id_fkey foreign key (issue_id) references f01_engineering.jira_issues (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_worklogs_author_account_id_fkey') then
    alter table f01_engineering.jira_worklogs
      add constraint jira_worklogs_author_account_id_fkey foreign key (author_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_attachments_issue_id_fkey') then
    alter table f01_engineering.jira_attachments
      add constraint jira_attachments_issue_id_fkey foreign key (issue_id) references f01_engineering.jira_issues (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_attachments_author_account_id_fkey') then
    alter table f01_engineering.jira_attachments
      add constraint jira_attachments_author_account_id_fkey foreign key (author_account_id) references f01_engineering.jira_users (account_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issue_links_link_type_id_fkey') then
    alter table f01_engineering.jira_issue_links
      add constraint jira_issue_links_link_type_id_fkey foreign key (link_type_id) references f01_engineering.jira_link_types (link_type_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issue_sprints_issue_id_fkey') then
    alter table f01_engineering.jira_issue_sprints
      add constraint jira_issue_sprints_issue_id_fkey foreign key (issue_id) references f01_engineering.jira_issues (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_issue_sprints_sprint_id_fkey') then
    alter table f01_engineering.jira_issue_sprints
      add constraint jira_issue_sprints_sprint_id_fkey foreign key (sprint_id) references f01_engineering.jira_sprints (sprint_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'jira_field_options_field_id_fkey') then
    alter table f01_engineering.jira_field_options
      add constraint jira_field_options_field_id_fkey foreign key (field_id) references f01_engineering.jira_fields (field_id);
  end if;
end $$;

create or replace view f01_engineering.jira_issue_overview as
select
  i.issue_id,
  i.issue_key,
  i.summary,
  t.name as issue_type,
  s.name as status,
  s.category_key as status_category,
  s.category_name as status_category_name,
  p.name as priority,
  tm.name as team,
  coalesce(au.display_name, 'Unassigned') as assignee,
  coalesce(ru.display_name, 'Unassigned') as reporter,
  coalesce(cu.display_name, 'Unassigned') as creator,
  parent.issue_key as parent_key,
  i.module,
  i.module_tags,
  i.sub_module_tags,
  i.feature,
  i.environment,
  i.severity,
  i.root_cause_tags,
  i.source_tags,
  i.labels
from f01_engineering.jira_issues i
left join f01_engineering.jira_issue_types t on t.issue_type_id = i.issue_type_id
left join f01_engineering.jira_statuses s on s.status_id = i.status_id
left join f01_engineering.jira_priorities p on p.priority_id = i.priority_id
left join f01_engineering.jira_teams tm on tm.team_id = i.team_id
left join f01_engineering.jira_users au on au.account_id = i.assignee_account_id
left join f01_engineering.jira_users ru on ru.account_id = i.reporter_account_id
left join f01_engineering.jira_users cu on cu.account_id = i.creator_account_id
left join f01_engineering.jira_issues parent on parent.issue_id = i.parent_issue_id
where i.deleted_at is null;

create or replace view f01_engineering.jira_tag_values as
select field, value, count(distinct issue_id) as issue_count
from (
  select i.issue_id, 'labels'::text as field, v as value
  from f01_engineering.jira_issues i
  cross join lateral unnest(i.labels) as v
  where i.deleted_at is null
  union all
  select i.issue_id, 'module_tags', v
  from f01_engineering.jira_issues i
  cross join lateral unnest(i.module_tags) as v
  where i.deleted_at is null
  union all
  select i.issue_id, 'sub_module_tags', v
  from f01_engineering.jira_issues i
  cross join lateral unnest(i.sub_module_tags) as v
  where i.deleted_at is null
  union all
  select i.issue_id, 'root_cause_tags', v
  from f01_engineering.jira_issues i
  cross join lateral unnest(i.root_cause_tags) as v
  where i.deleted_at is null
  union all
  select i.issue_id, 'source_tags', v
  from f01_engineering.jira_issues i
  cross join lateral unnest(i.source_tags) as v
  where i.deleted_at is null
) tags
group by field, value;

comment on table f01_engineering.jira_projects is 'Jira project. SPEND is the first one loaded.';
comment on column f01_engineering.jira_projects.project_id is 'Jira project id.';
comment on column f01_engineering.jira_projects.project_key is 'Project key, such as SPEND.';
comment on column f01_engineering.jira_projects.name is 'Project name.';
comment on column f01_engineering.jira_projects.project_type is 'Jira projectTypeKey, such as software.';
comment on column f01_engineering.jira_projects.style is 'Jira style, such as next-gen. Null until the project resource is fetched.';
comment on column f01_engineering.jira_projects.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_issue_types is 'Issue types used by the synced projects.';
comment on column f01_engineering.jira_issue_types.issue_type_id is 'Jira issue type id.';
comment on column f01_engineering.jira_issue_types.name is 'Issue type name.';
comment on column f01_engineering.jira_issue_types.hierarchy_level is 'Jira hierarchyLevel. Epics are 1, standard types are 0, subtasks are -1.';
comment on column f01_engineering.jira_issue_types.is_subtask is 'True when the type is a subtask.';
comment on column f01_engineering.jira_issue_types.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_statuses is 'Workflow statuses and their status categories.';
comment on column f01_engineering.jira_statuses.status_id is 'Jira status id.';
comment on column f01_engineering.jira_statuses.name is 'Status name.';
comment on column f01_engineering.jira_statuses.category_key is 'Status category key: new, indeterminate, or done.';
comment on column f01_engineering.jira_statuses.category_name is 'Status category name.';
comment on column f01_engineering.jira_statuses.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_priorities is 'Jira priorities, including the site spelling of each name.';
comment on column f01_engineering.jira_priorities.priority_id is 'Jira priority id.';
comment on column f01_engineering.jira_priorities.name is 'Priority name as Jira stores it.';
comment on column f01_engineering.jira_priorities.sort_order is 'Position in the priority catalog, starting at 0. Null until that catalog is fetched.';
comment on column f01_engineering.jira_priorities.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_teams is 'Atlassian teams referenced by issues. Not user accounts.';
comment on column f01_engineering.jira_teams.team_id is 'Atlassian team id.';
comment on column f01_engineering.jira_teams.name is 'Team name.';
comment on column f01_engineering.jira_teams.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_users is 'Jira accounts seen on issues. Email addresses are not stored.';
comment on column f01_engineering.jira_users.account_id is 'Atlassian account id.';
comment on column f01_engineering.jira_users.display_name is 'Display name. No email address.';
comment on column f01_engineering.jira_users.account_type is 'Jira accountType, such as atlassian or app.';
comment on column f01_engineering.jira_users.active is 'Whether the account is active.';
comment on column f01_engineering.jira_users.time_zone is 'Account time zone, when Jira sent one.';
comment on column f01_engineering.jira_users.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_issues is 'One row per Jira issue in the synced project, including issues later marked deleted.';
comment on column f01_engineering.jira_issues.issue_id is 'Jira issue id.';
comment on column f01_engineering.jira_issues.issue_key is 'Unique issue key.';
comment on column f01_engineering.jira_issues.project_id is 'Project the issue belongs to.';
comment on column f01_engineering.jira_issues.summary is 'Issue summary, with surrounding whitespace removed.';
comment on column f01_engineering.jira_issues.description_text is 'Full description text converted from ADF. Not truncated.';
comment on column f01_engineering.jira_issues.description_adf is 'Original description document.';
comment on column f01_engineering.jira_issues.issue_type_id is 'Issue type.';
comment on column f01_engineering.jira_issues.parent_issue_id is 'Parent issue id. Indexed, and not a foreign key, so a missing parent does not block the row.';
comment on column f01_engineering.jira_issues.status_id is 'Current status.';
comment on column f01_engineering.jira_issues.resolution is 'Resolution name. Null when the issue has none.';
comment on column f01_engineering.jira_issues.priority_id is 'Priority. Null when Jira has none.';
comment on column f01_engineering.jira_issues.flagged is 'True when the Flagged field is non-empty.';
comment on column f01_engineering.jira_issues.assignee_account_id is 'Assignee account. Null when unassigned.';
comment on column f01_engineering.jira_issues.reporter_account_id is 'Reporter account.';
comment on column f01_engineering.jira_issues.creator_account_id is 'Creator account.';
comment on column f01_engineering.jira_issues.team_id is 'Atlassian team on the issue.';
comment on column f01_engineering.jira_issues.created_at is 'When Jira created the issue.';
comment on column f01_engineering.jira_issues.updated_at is 'When Jira last updated the issue. This is the incremental cursor.';
comment on column f01_engineering.jira_issues.resolved_at is 'Resolution time. Null when unresolved.';
comment on column f01_engineering.jira_issues.status_changed_at is 'When the status category last changed.';
comment on column f01_engineering.jira_issues.due_date is 'Due date, as a calendar date.';
comment on column f01_engineering.jira_issues.start_date is 'Start date from customfield_10015.';
comment on column f01_engineering.jira_issues.story_points is 'Story point estimate from customfield_10016, including a stored -1.';
comment on column f01_engineering.jira_issues.original_estimate_seconds is 'Original time estimate in seconds.';
comment on column f01_engineering.jira_issues.remaining_estimate_seconds is 'Remaining time estimate in seconds.';
comment on column f01_engineering.jira_issues.time_spent_seconds is 'Time spent in seconds.';
comment on column f01_engineering.jira_issues.module is 'Select Module, customfield_10832. Not the labels Module field.';
comment on column f01_engineering.jira_issues.module_tags is 'Labels Module, customfield_10585.';
comment on column f01_engineering.jira_issues.sub_module_tags is 'Sub Module labels, customfield_10618.';
comment on column f01_engineering.jira_issues.feature is 'Select Feature, customfield_10833. Not the Feature issue type.';
comment on column f01_engineering.jira_issues.environment is 'Select Environment, customfield_10831, with surrounding whitespace removed. The empty system environment field is not used.';
comment on column f01_engineering.jira_issues.severity is 'Severity from customfield_10794. One value is stored as itself; several are comma-joined.';
comment on column f01_engineering.jira_issues.root_cause_tags is 'Root Cause labels, customfield_10796.';
comment on column f01_engineering.jira_issues.source_tags is 'Union of the two Source fields, customfield_10795 and customfield_10797.';
comment on column f01_engineering.jira_issues.labels is 'Jira labels.';
comment on column f01_engineering.jira_issues.comment_count is 'comment.total from Jira.';
comment on column f01_engineering.jira_issues.attachment_count is 'Number of attachment metadata rows.';
comment on column f01_engineering.jira_issues.watcher_count is 'Watcher count. Watcher accounts are not stored.';
comment on column f01_engineering.jira_issues.synced_at is 'When this row was last changed by a sync.';
comment on column f01_engineering.jira_issues.deleted_at is 'When a nightly id scan no longer returned this issue. Null while it is in the project.';

comment on table f01_engineering.jira_comments is 'Issue comments. The set for an issue is replaced on each sync of that issue.';
comment on column f01_engineering.jira_comments.comment_id is 'Jira comment id.';
comment on column f01_engineering.jira_comments.issue_id is 'Issue the comment belongs to.';
comment on column f01_engineering.jira_comments.author_account_id is 'Comment author.';
comment on column f01_engineering.jira_comments.update_author_account_id is 'Account that last updated the comment.';
comment on column f01_engineering.jira_comments.created_at is 'When the comment was created.';
comment on column f01_engineering.jira_comments.updated_at is 'When the comment was last updated.';
comment on column f01_engineering.jira_comments.body_text is 'Full comment text converted from ADF. Not truncated.';
comment on column f01_engineering.jira_comments.body_adf is 'Original comment document.';
comment on column f01_engineering.jira_comments.visibility is 'Jira visibility restriction, when set.';
comment on column f01_engineering.jira_comments.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_issue_changes is 'One row per changelog item. item_index is the zero-based position in that history.';
comment on column f01_engineering.jira_issue_changes.history_id is 'Jira changelog history id.';
comment on column f01_engineering.jira_issue_changes.item_index is 'Zero-based index of the item inside the history.';
comment on column f01_engineering.jira_issue_changes.issue_id is 'Issue that changed.';
comment on column f01_engineering.jira_issue_changes.author_account_id is 'Account that made the change.';
comment on column f01_engineering.jira_issue_changes.changed_at is 'When the history was created.';
comment on column f01_engineering.jira_issue_changes.field is 'Field name Jira recorded.';
comment on column f01_engineering.jira_issue_changes.field_id is 'Field id Jira recorded.';
comment on column f01_engineering.jira_issue_changes.field_type is 'Jira fieldtype, such as jira or custom.';
comment on column f01_engineering.jira_issue_changes.from_value is 'Previous stored value.';
comment on column f01_engineering.jira_issue_changes.from_display is 'Previous display value.';
comment on column f01_engineering.jira_issue_changes.to_value is 'New stored value.';
comment on column f01_engineering.jira_issue_changes.to_display is 'New display value.';
comment on column f01_engineering.jira_issue_changes.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_worklogs is 'Worklogs. The set for an issue is replaced on each sync of that issue.';
comment on column f01_engineering.jira_worklogs.worklog_id is 'Jira worklog id.';
comment on column f01_engineering.jira_worklogs.issue_id is 'Issue the work was logged on.';
comment on column f01_engineering.jira_worklogs.author_account_id is 'Account that logged the work.';
comment on column f01_engineering.jira_worklogs.started_at is 'When the work started.';
comment on column f01_engineering.jira_worklogs.time_spent_seconds is 'Time spent in seconds.';
comment on column f01_engineering.jira_worklogs.created_at is 'When the worklog was created.';
comment on column f01_engineering.jira_worklogs.updated_at is 'When the worklog was last updated.';
comment on column f01_engineering.jira_worklogs.comment_text is 'Full worklog comment text. Not truncated.';
comment on column f01_engineering.jira_worklogs.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_attachments is 'Attachment metadata only. File bytes are never downloaded.';
comment on column f01_engineering.jira_attachments.attachment_id is 'Jira attachment id.';
comment on column f01_engineering.jira_attachments.issue_id is 'Issue the file is attached to.';
comment on column f01_engineering.jira_attachments.filename is 'File name.';
comment on column f01_engineering.jira_attachments.mime_type is 'MIME type.';
comment on column f01_engineering.jira_attachments.size_bytes is 'Size in bytes.';
comment on column f01_engineering.jira_attachments.author_account_id is 'Account that uploaded the file.';
comment on column f01_engineering.jira_attachments.created_at is 'When the file was attached.';
comment on column f01_engineering.jira_attachments.content_url is 'Jira content URL. The file itself is not stored.';
comment on column f01_engineering.jira_attachments.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_link_types is 'Issue link types from the site catalog and from links seen on issues.';
comment on column f01_engineering.jira_link_types.link_type_id is 'Jira link type id.';
comment on column f01_engineering.jira_link_types.name is 'Link type name.';
comment on column f01_engineering.jira_link_types.outward is 'Outward description, such as blocks.';
comment on column f01_engineering.jira_link_types.inward is 'Inward description, such as is blocked by.';
comment on column f01_engineering.jira_link_types.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_issue_links is 'Issue links. Endpoints are not foreign keys because the other issue may be in another project.';
comment on column f01_engineering.jira_issue_links.link_id is 'Jira issue link id.';
comment on column f01_engineering.jira_issue_links.link_type_id is 'Link type.';
comment on column f01_engineering.jira_issue_links.outward_issue_id is 'Issue id on the outward end. Not a foreign key.';
comment on column f01_engineering.jira_issue_links.inward_issue_id is 'Issue id on the inward end. Not a foreign key.';
comment on column f01_engineering.jira_issue_links.outward_issue_key is 'Issue key on the outward end.';
comment on column f01_engineering.jira_issue_links.inward_issue_key is 'Issue key on the inward end.';
comment on column f01_engineering.jira_issue_links.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_boards is 'Boards whose filter includes the synced project.';
comment on column f01_engineering.jira_boards.board_id is 'Jira board id.';
comment on column f01_engineering.jira_boards.name is 'Board name.';
comment on column f01_engineering.jira_boards.board_type is 'Board type, such as simple or scrum.';
comment on column f01_engineering.jira_boards.location_project_id is 'Project the board is located on.';
comment on column f01_engineering.jira_boards.filter_jql is 'JQL of the board filter.';
comment on column f01_engineering.jira_boards.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_sprints is 'Sprints from boards and from the sprint field on issues.';
comment on column f01_engineering.jira_sprints.sprint_id is 'Jira sprint id.';
comment on column f01_engineering.jira_sprints.board_id is 'Board id from the sprint. Not a foreign key, so a sprint can be stored before its board row exists.';
comment on column f01_engineering.jira_sprints.name is 'Sprint name.';
comment on column f01_engineering.jira_sprints.state is 'Sprint state: future, active, or closed.';
comment on column f01_engineering.jira_sprints.start_at is 'Sprint start.';
comment on column f01_engineering.jira_sprints.end_at is 'Sprint end.';
comment on column f01_engineering.jira_sprints.complete_at is 'When the sprint was completed.';
comment on column f01_engineering.jira_sprints.goal is 'Sprint goal, as Jira stores it.';
comment on column f01_engineering.jira_sprints.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_issue_sprints is 'Every sprint an issue has been in. Replaced per issue on each sync.';
comment on column f01_engineering.jira_issue_sprints.issue_id is 'Issue.';
comment on column f01_engineering.jira_issue_sprints.sprint_id is 'Sprint.';
comment on column f01_engineering.jira_issue_sprints.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_fields is 'Field catalog. column_name maps a field onto a clean column; description is left for a person to fill in.';
comment on column f01_engineering.jira_fields.field_id is 'Jira field id, such as summary or customfield_10832.';
comment on column f01_engineering.jira_fields.jira_name is 'Field name in Jira. Names are not unique.';
comment on column f01_engineering.jira_fields.column_name is 'Clean column this field feeds, when the sync maps it.';
comment on column f01_engineering.jira_fields.schema_type is 'Jira schema type. Array fields include the item type.';
comment on column f01_engineering.jira_fields.is_custom is 'True for custom fields.';
comment on column f01_engineering.jira_fields.description is 'Human description. The sync does not overwrite a value that was filled in by hand.';
comment on column f01_engineering.jira_fields.synced_at is 'When this row was last changed by a sync.';

comment on table f01_engineering.jira_field_options is 'Dropdown options. Loaded from create metadata because field contexts are not readable by this account.';
comment on column f01_engineering.jira_field_options.field_id is 'Field the option belongs to.';
comment on column f01_engineering.jira_field_options.option_id is 'Jira option id.';
comment on column f01_engineering.jira_field_options.value is 'Option value.';
comment on column f01_engineering.jira_field_options.is_disabled is 'True when Jira marks the option disabled. Create metadata usually omits disabled options.';
comment on column f01_engineering.jira_field_options.synced_at is 'When this row was last changed by a sync.';

comment on view f01_engineering.jira_issue_overview is
  'Non-deleted issues with type, status, priority, team, people, parent key, and product-area columns.';
comment on column f01_engineering.jira_issue_overview.issue_id is 'Jira issue id.';
comment on column f01_engineering.jira_issue_overview.issue_key is 'Issue key.';
comment on column f01_engineering.jira_issue_overview.summary is 'Issue summary.';
comment on column f01_engineering.jira_issue_overview.issue_type is 'Issue type name.';
comment on column f01_engineering.jira_issue_overview.status is 'Status name.';
comment on column f01_engineering.jira_issue_overview.status_category is 'Status category key.';
comment on column f01_engineering.jira_issue_overview.status_category_name is 'Status category name.';
comment on column f01_engineering.jira_issue_overview.priority is 'Priority name.';
comment on column f01_engineering.jira_issue_overview.team is 'Team name.';
comment on column f01_engineering.jira_issue_overview.assignee is 'Assignee display name, or Unassigned when there is none.';
comment on column f01_engineering.jira_issue_overview.reporter is 'Reporter display name, or Unassigned when there is none.';
comment on column f01_engineering.jira_issue_overview.creator is 'Creator display name, or Unassigned when there is none.';
comment on column f01_engineering.jira_issue_overview.parent_key is 'Parent issue key.';
comment on column f01_engineering.jira_issue_overview.module is 'Select Module.';
comment on column f01_engineering.jira_issue_overview.module_tags is 'Labels Module.';
comment on column f01_engineering.jira_issue_overview.sub_module_tags is 'Sub Module labels.';
comment on column f01_engineering.jira_issue_overview.feature is 'Select Feature.';
comment on column f01_engineering.jira_issue_overview.environment is 'Trimmed select Environment.';
comment on column f01_engineering.jira_issue_overview.severity is 'Severity.';
comment on column f01_engineering.jira_issue_overview.root_cause_tags is 'Root Cause labels.';
comment on column f01_engineering.jira_issue_overview.source_tags is 'Combined Source labels.';
comment on column f01_engineering.jira_issue_overview.labels is 'Jira labels.';

comment on view f01_engineering.jira_tag_values is
  'Distinct values of each tag-style column and how many non-deleted issues use each value.';
comment on column f01_engineering.jira_tag_values.field is
  'Tag column: labels, module_tags, sub_module_tags, root_cause_tags, or source_tags.';
comment on column f01_engineering.jira_tag_values.value is 'One tag value.';
comment on column f01_engineering.jira_tag_values.issue_count is 'Non-deleted issues that carry this value.';

revoke all on schema f01_engineering from public, anon, authenticated;
revoke all on all tables in schema f01_engineering from public, anon, authenticated;
revoke all on all sequences in schema f01_engineering from public, anon, authenticated;
revoke all on all functions in schema f01_engineering from public, anon, authenticated;
alter default privileges in schema f01_engineering revoke all on tables from public, anon, authenticated;
alter default privileges in schema f01_engineering revoke all on sequences from public, anon, authenticated;
alter default privileges in schema f01_engineering revoke all on functions from public, anon, authenticated;

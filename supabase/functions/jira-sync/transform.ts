/**
 * Pure transforms from Jira JSON to clean rows.
 * Email addresses are never copied onto a row.
 */

import { adfToText } from "./adf.ts";

/** Clean column fed by each Jira field. Both Source fields share source_tags. */
export const COLUMN_BY_FIELD_ID: Record<string, string> = {
  summary: "summary",
  description: "description_text",
  issuetype: "issue_type_id",
  parent: "parent_issue_id",
  status: "status_id",
  resolution: "resolution",
  priority: "priority_id",
  customfield_10021: "flagged",
  assignee: "assignee_account_id",
  reporter: "reporter_account_id",
  creator: "creator_account_id",
  customfield_10001: "team_id",
  created: "created_at",
  updated: "updated_at",
  resolutiondate: "resolved_at",
  statuscategorychangedate: "status_changed_at",
  duedate: "due_date",
  customfield_10015: "start_date",
  customfield_10016: "story_points",
  timeoriginalestimate: "original_estimate_seconds",
  timeestimate: "remaining_estimate_seconds",
  timespent: "time_spent_seconds",
  customfield_10832: "module",
  customfield_10585: "module_tags",
  customfield_10618: "sub_module_tags",
  customfield_10833: "feature",
  customfield_10831: "environment",
  customfield_10794: "severity",
  customfield_10796: "root_cause_tags",
  customfield_10795: "source_tags",
  customfield_10797: "source_tags",
  labels: "labels",
  comment: "comment_count",
  attachment: "attachment_count",
  watches: "watcher_count",
};

export interface UserRow {
  account_id: string;
  display_name: string | null;
  account_type: string | null;
  active: boolean | null;
  time_zone: string | null;
}

export interface ProjectRow {
  project_id: number;
  project_key: string;
  name: string | null;
  project_type: string | null;
  style: string | null;
}

export interface IssueTypeRow {
  issue_type_id: number;
  name: string | null;
  hierarchy_level: number | null;
  is_subtask: boolean | null;
}

export interface StatusRow {
  status_id: number;
  name: string | null;
  category_key: string | null;
  category_name: string | null;
}

export interface PriorityRow {
  priority_id: number;
  name: string | null;
  sort_order: number | null;
}

export interface TeamRow {
  team_id: string;
  name: string | null;
}

export interface LinkTypeRow {
  link_type_id: number;
  name: string | null;
  outward: string | null;
  inward: string | null;
}

export interface SprintRow {
  sprint_id: number;
  board_id: number | null;
  name: string | null;
  state: string | null;
  start_at: string | null;
  end_at: string | null;
  complete_at: string | null;
  goal: string | null;
}

export interface IssueRow {
  issue_id: number;
  issue_key: string;
  project_id: number;
  summary: string | null;
  description_text: string | null;
  description_adf: unknown;
  issue_type_id: number;
  parent_issue_id: number | null;
  status_id: number;
  resolution: string | null;
  priority_id: number | null;
  flagged: boolean;
  assignee_account_id: string | null;
  reporter_account_id: string | null;
  creator_account_id: string | null;
  team_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
  status_changed_at: string | null;
  due_date: string | null;
  start_date: string | null;
  story_points: number | null;
  original_estimate_seconds: number | null;
  remaining_estimate_seconds: number | null;
  time_spent_seconds: number | null;
  module: string | null;
  module_tags: string[] | null;
  sub_module_tags: string[] | null;
  feature: string | null;
  environment: string | null;
  severity: string | null;
  root_cause_tags: string[] | null;
  source_tags: string[] | null;
  labels: string[] | null;
  comment_count: number | null;
  attachment_count: number | null;
  watcher_count: number | null;
  deleted_at: string | null;
}

export interface CommentRow {
  comment_id: number;
  issue_id: number;
  author_account_id: string | null;
  update_author_account_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  body_text: string | null;
  body_adf: unknown;
  visibility: unknown;
}

export interface ChangeRow {
  history_id: number;
  item_index: number;
  issue_id: number;
  author_account_id: string | null;
  changed_at: string | null;
  field: string | null;
  field_id: string | null;
  field_type: string | null;
  from_value: string | null;
  from_display: string | null;
  to_value: string | null;
  to_display: string | null;
}

export interface WorklogRow {
  worklog_id: number;
  issue_id: number;
  author_account_id: string | null;
  started_at: string | null;
  time_spent_seconds: number | null;
  created_at: string | null;
  updated_at: string | null;
  comment_text: string | null;
}

export interface AttachmentRow {
  attachment_id: number;
  issue_id: number;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  author_account_id: string | null;
  created_at: string | null;
  content_url: string | null;
}

export interface LinkRow {
  link_id: number;
  link_type_id: number | null;
  outward_issue_id: number | null;
  inward_issue_id: number | null;
  outward_issue_key: string | null;
  inward_issue_key: string | null;
}

export interface IssueSprintRow {
  issue_id: number;
  sprint_id: number;
}

export interface FieldRow {
  field_id: string;
  jira_name: string | null;
  column_name: string | null;
  schema_type: string | null;
  is_custom: boolean | null;
  description: string | null;
}

export interface FieldOptionRow {
  field_id: string;
  option_id: string;
  value: string | null;
  is_disabled: boolean | null;
}

export interface BoardRow {
  board_id: number;
  name: string | null;
  board_type: string | null;
  location_project_id: number | null;
  filter_jql: string | null;
}

export interface IssueBundle {
  project: ProjectRow | null;
  issueType: IssueTypeRow | null;
  status: StatusRow | null;
  priority: PriorityRow | null;
  team: TeamRow | null;
  users: UserRow[];
  linkTypes: LinkTypeRow[];
  sprints: SprintRow[];
  issue: IssueRow;
  comments: CommentRow[];
  changes: ChangeRow[];
  worklogs: WorklogRow[];
  attachments: AttachmentRow[];
  links: LinkRow[];
  issueSprints: IssueSprintRow[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim();
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string") items.push(item.trim());
  }
  return items;
}

function optionValue(value: unknown): string | null {
  const row = record(value);
  if (!row) return null;
  return trimmed(row.value);
}

/** Drop every emailAddress key, at any depth, before a payload is stored. */
export function stripEmailAddresses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripEmailAddresses(item));
  const row = record(value);
  if (!row) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(row)) {
    if (key === "emailAddress") continue;
    copy[key] = stripEmailAddresses(child);
  }
  return copy;
}

/** Merge user rows by account id, keeping whichever copy has each attribute. */
export function dedupeUsers(users: UserRow[]): UserRow[] {
  const merged = new Map<string, UserRow>();
  for (const user of users) {
    const existing = merged.get(user.account_id);
    if (!existing) {
      merged.set(user.account_id, user);
      continue;
    }
    merged.set(user.account_id, {
      account_id: user.account_id,
      display_name: user.display_name ?? existing.display_name,
      account_type: user.account_type ?? existing.account_type,
      active: user.active ?? existing.active,
      time_zone: user.time_zone ?? existing.time_zone,
    });
  }
  return [...merged.values()];
}

export interface UserReference {
  users: UserRow[];
  raw: Array<{ kind: string; ref_id: string; payload: unknown }>;
}

/**
 * Map `/user/bulk` account payloads to clean rows and raw reference rows.
 * Every emailAddress key is removed before the payload is stored.
 */
export function transformUserBulk(payloads: unknown[]): UserReference {
  const users: UserRow[] = [];
  const raw: UserReference["raw"] = [];
  for (const payload of payloads) {
    const stripped = stripEmailAddresses(payload);
    const row = record(stripped);
    const accountId = text(row?.accountId);
    if (!row || !accountId) continue;
    users.push({
      account_id: accountId,
      display_name: text(row.displayName),
      account_type: text(row.accountType),
      active: bool(row.active),
      time_zone: text(row.timeZone),
    });
    raw.push({ kind: "user", ref_id: accountId, payload: stripped });
  }
  return { users: dedupeUsers(users), raw };
}

function readUser(value: unknown, into: UserRow[]): string | null {
  const row = record(value);
  if (!row) return null;
  const accountId = text(row.accountId);
  if (!accountId) return null;
  into.push({
    account_id: accountId,
    display_name: text(row.displayName),
    account_type: text(row.accountType),
    active: bool(row.active),
    time_zone: text(row.timeZone),
  });
  return accountId;
}

function bodyText(value: unknown): { text: string | null; adf: unknown } {
  if (typeof value === "string") return { text: value, adf: null };
  if (record(value)) return { text: adfToText(value), adf: value };
  return { text: null, adf: null };
}

function unionTags(left: unknown, right: unknown): string[] | null {
  const first = stringList(left);
  const second = stringList(right);
  if (!first && !second) return null;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const tag of [...(first ?? []), ...(second ?? [])]) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    values.push(tag);
  }
  return values;
}

function severityValue(value: unknown): string | null {
  const tags = stringList(value);
  if (!tags || tags.length === 0) return null;
  if (tags.length === 1) return tags[0];
  return tags.join(", ");
}

function readProject(value: unknown): ProjectRow | null {
  const row = record(value);
  const projectId = integer(row?.id);
  const projectKey = text(row?.key);
  if (!row || projectId === null || !projectKey) return null;
  return {
    project_id: projectId,
    project_key: projectKey,
    name: text(row.name),
    project_type: text(row.projectTypeKey),
    style: text(row.style),
  };
}

function readIssueType(value: unknown): IssueTypeRow | null {
  const row = record(value);
  const issueTypeId = integer(row?.id);
  if (!row || issueTypeId === null) return null;
  return {
    issue_type_id: issueTypeId,
    name: text(row.name),
    hierarchy_level: integer(row.hierarchyLevel),
    is_subtask: bool(row.subtask),
  };
}

function readStatus(value: unknown): StatusRow | null {
  const row = record(value);
  const statusId = integer(row?.id);
  if (!row || statusId === null) return null;
  const category = record(row.statusCategory);
  return {
    status_id: statusId,
    name: text(row.name),
    category_key: text(category?.key),
    category_name: text(category?.name),
  };
}

function readPriority(value: unknown, sortOrder: number | null = null): PriorityRow | null {
  const row = record(value);
  const priorityId = integer(row?.id);
  if (!row || priorityId === null) return null;
  return {
    priority_id: priorityId,
    name: text(row.name),
    sort_order: sortOrder,
  };
}

function readTeam(value: unknown): TeamRow | null {
  const row = record(value);
  const teamId = text(row?.id);
  if (!row || !teamId) return null;
  return { team_id: teamId, name: text(row.name) ?? text(row.title) };
}

function readSprint(value: unknown): SprintRow | null {
  const row = record(value);
  const sprintId = integer(row?.id);
  if (!row || sprintId === null) return null;
  return {
    sprint_id: sprintId,
    board_id: integer(row.boardId ?? row.originBoardId),
    name: text(row.name),
    state: text(row.state),
    start_at: timestamp(row.startDate),
    end_at: timestamp(row.endDate),
    complete_at: timestamp(row.completeDate),
    goal: text(row.goal),
  };
}

function endpoint(
  value: unknown,
  fallbackId: number,
  fallbackKey: string,
): { id: number | null; key: string | null } {
  const row = record(value);
  if (!row) return { id: fallbackId, key: fallbackKey };
  return { id: integer(row.id), key: text(row.key) };
}

function readLinks(
  issueId: number,
  issueKey: string,
  value: unknown,
): { links: LinkRow[]; types: LinkTypeRow[] } {
  if (!Array.isArray(value)) return { links: [], types: [] };
  const links: LinkRow[] = [];
  const types: LinkTypeRow[] = [];
  for (const item of value) {
    const row = record(item);
    const linkId = integer(row?.id);
    if (!row || linkId === null) continue;
    const type = record(row.type);
    const linkTypeId = integer(type?.id);
    if (type && linkTypeId !== null) {
      types.push({
        link_type_id: linkTypeId,
        name: text(type.name),
        outward: text(type.outward),
        inward: text(type.inward),
      });
    }
    const hasInward = record(row.inwardIssue) !== null;
    const hasOutward = record(row.outwardIssue) !== null;
    let inward = { id: null as number | null, key: null as string | null };
    let outward = { id: null as number | null, key: null as string | null };
    if (hasInward && hasOutward) {
      inward = endpoint(row.inwardIssue, issueId, issueKey);
      outward = endpoint(row.outwardIssue, issueId, issueKey);
    } else if (hasInward) {
      // The nested issue is the inward end, so this issue is the outward end.
      inward = endpoint(row.inwardIssue, issueId, issueKey);
      outward = { id: issueId, key: issueKey };
    } else if (hasOutward) {
      outward = endpoint(row.outwardIssue, issueId, issueKey);
      inward = { id: issueId, key: issueKey };
    }
    links.push({
      link_id: linkId,
      link_type_id: linkTypeId,
      outward_issue_id: outward.id,
      inward_issue_id: inward.id,
      outward_issue_key: outward.key,
      inward_issue_key: inward.key,
    });
  }
  return { links, types };
}

function readComments(issueId: number, value: unknown, users: UserRow[]): CommentRow[] {
  if (!Array.isArray(value)) return [];
  const comments: CommentRow[] = [];
  for (const item of value) {
    const row = record(item);
    const commentId = integer(row?.id);
    if (!row || commentId === null) continue;
    const body = bodyText(row.body);
    comments.push({
      comment_id: commentId,
      issue_id: issueId,
      author_account_id: readUser(row.author, users),
      update_author_account_id: readUser(row.updateAuthor, users),
      created_at: timestamp(row.created),
      updated_at: timestamp(row.updated),
      body_text: body.text,
      body_adf: body.adf,
      visibility: record(row.visibility) ? row.visibility : null,
    });
  }
  return comments;
}

function readWorklogs(issueId: number, value: unknown, users: UserRow[]): WorklogRow[] {
  if (!Array.isArray(value)) return [];
  const worklogs: WorklogRow[] = [];
  for (const item of value) {
    const row = record(item);
    const worklogId = integer(row?.id);
    if (!row || worklogId === null) continue;
    const comment = bodyText(row.comment);
    worklogs.push({
      worklog_id: worklogId,
      issue_id: issueId,
      author_account_id: readUser(row.author, users),
      started_at: timestamp(row.started),
      time_spent_seconds: integer(row.timeSpentSeconds),
      created_at: timestamp(row.created),
      updated_at: timestamp(row.updated),
      comment_text: comment.text,
    });
  }
  return worklogs;
}

function readChanges(issueId: number, histories: unknown, users: UserRow[]): ChangeRow[] {
  if (!Array.isArray(histories)) return [];
  const changes: ChangeRow[] = [];
  for (const history of histories) {
    const row = record(history);
    const historyId = integer(row?.id);
    if (!row || historyId === null) continue;
    const authorId = readUser(row.author, users);
    const items = Array.isArray(row.items) ? row.items : [];
    for (let index = 0; index < items.length; index += 1) {
      const change = record(items[index]);
      if (!change) continue;
      changes.push({
        history_id: historyId,
        item_index: index,
        issue_id: issueId,
        author_account_id: authorId,
        changed_at: timestamp(row.created),
        field: text(change.field),
        field_id: text(change.fieldId),
        field_type: text(change.fieldtype),
        from_value: text(change.from),
        from_display: text(change.fromString),
        to_value: text(change.to),
        to_display: text(change.toString),
      });
    }
  }
  return changes;
}

function readAttachments(issueId: number, value: unknown, users: UserRow[]): AttachmentRow[] {
  if (!Array.isArray(value)) return [];
  const attachments: AttachmentRow[] = [];
  for (const item of value) {
    const row = record(item);
    const attachmentId = integer(row?.id);
    if (!row || attachmentId === null) continue;
    attachments.push({
      attachment_id: attachmentId,
      issue_id: issueId,
      filename: text(row.filename),
      mime_type: text(row.mimeType),
      size_bytes: integer(row.size),
      author_account_id: readUser(row.author, users),
      created_at: timestamp(row.created),
      content_url: text(row.content),
    });
  }
  return attachments;
}

export interface TransformIssueInput {
  issue: unknown;
  comments: unknown[];
  worklogs: unknown[];
  histories: unknown[];
  deletedAt?: string | null;
}

/** Map one issue, plus the comments, worklogs, and changelog histories that belong to it. */
export function transformIssue(input: TransformIssueInput): IssueBundle | null {
  const issue = record(input.issue);
  const fields = record(issue?.fields);
  const issueId = integer(issue?.id);
  const issueKey = text(issue?.key);
  if (!issue || !fields || issueId === null || !issueKey) return null;

  const users: UserRow[] = [];
  const project = readProject(fields.project);
  const issueType = readIssueType(fields.issuetype);
  const status = readStatus(fields.status);
  const priority = readPriority(fields.priority);
  const team = readTeam(fields.customfield_10001);
  const parent = record(fields.parent);
  const description = bodyText(fields.description);
  const sprints = Array.isArray(fields.customfield_10020)
    ? fields.customfield_10020.flatMap((item) => {
      const sprint = readSprint(item);
      return sprint ? [sprint] : [];
    })
    : [];
  const linkData = readLinks(issueId, issueKey, fields.issuelinks);
  const comments = readComments(issueId, input.comments, users);
  const worklogs = readWorklogs(issueId, input.worklogs, users);
  const changes = readChanges(issueId, input.histories, users);
  const attachments = readAttachments(issueId, fields.attachment, users);
  const commentPage = record(fields.comment);
  const watches = record(fields.watches);

  if (!project || !issueType || !status) return null;

  readUser(fields.assignee, users);
  readUser(fields.reporter, users);
  readUser(fields.creator, users);

  const row: IssueRow = {
    issue_id: issueId,
    issue_key: issueKey,
    project_id: project.project_id,
    summary: trimmed(fields.summary),
    description_text: description.text,
    description_adf: description.adf,
    issue_type_id: issueType.issue_type_id,
    parent_issue_id: integer(parent?.id),
    status_id: status.status_id,
    resolution: trimmed(record(fields.resolution)?.name),
    priority_id: priority?.priority_id ?? null,
    flagged: Array.isArray(fields.customfield_10021) && fields.customfield_10021.length > 0,
    assignee_account_id: text(record(fields.assignee)?.accountId),
    reporter_account_id: text(record(fields.reporter)?.accountId),
    creator_account_id: text(record(fields.creator)?.accountId),
    team_id: team?.team_id ?? null,
    created_at: timestamp(fields.created),
    updated_at: timestamp(fields.updated),
    resolved_at: timestamp(fields.resolutiondate),
    status_changed_at: timestamp(fields.statuscategorychangedate),
    due_date: timestamp(fields.duedate),
    start_date: timestamp(fields.customfield_10015),
    story_points: numberValue(fields.customfield_10016),
    original_estimate_seconds: integer(fields.timeoriginalestimate),
    remaining_estimate_seconds: integer(fields.timeestimate),
    time_spent_seconds: integer(fields.timespent),
    module: optionValue(fields.customfield_10832),
    module_tags: stringList(fields.customfield_10585),
    sub_module_tags: stringList(fields.customfield_10618),
    feature: optionValue(fields.customfield_10833),
    environment: optionValue(fields.customfield_10831),
    severity: severityValue(fields.customfield_10794),
    root_cause_tags: stringList(fields.customfield_10796),
    source_tags: unionTags(fields.customfield_10795, fields.customfield_10797),
    labels: stringList(fields.labels),
    comment_count: integer(commentPage?.total),
    attachment_count: Array.isArray(fields.attachment) ? fields.attachment.length : null,
    watcher_count: integer(watches?.watchCount),
    deleted_at: input.deletedAt ?? null,
  };

  return {
    project,
    issueType,
    status,
    priority,
    team,
    users: dedupeUsers(users),
    linkTypes: linkData.types,
    sprints,
    issue: row,
    comments,
    changes,
    worklogs,
    attachments,
    links: linkData.links,
    issueSprints: sprints.map((sprint) => ({ issue_id: issueId, sprint_id: sprint.sprint_id })),
  };
}

/** Catalog field row. Description stays empty here; it is filled in by hand later. */
export function transformField(value: unknown): FieldRow | null {
  const row = record(value);
  const fieldId = text(row?.id);
  if (!row || !fieldId) return null;
  const schema = record(row.schema);
  let schemaType = text(schema?.type);
  if (schemaType === "array" && typeof schema?.items === "string") schemaType = `array<${schema.items}>`;
  return {
    field_id: fieldId,
    jira_name: text(row.name),
    column_name: COLUMN_BY_FIELD_ID[fieldId] ?? null,
    schema_type: schemaType,
    is_custom: bool(row.custom),
    description: null,
  };
}

/** Dropdown option from create metadata. The context API is not available to this account. */
export function transformFieldOption(fieldId: string, value: unknown): FieldOptionRow | null {
  const row = record(value);
  const optionId = text(row?.id) ?? (integer(row?.id) === null ? null : String(integer(row?.id)));
  if (!row || !optionId) return null;
  return {
    field_id: fieldId,
    option_id: optionId,
    value: text(row.value) ?? text(row.name),
    is_disabled: bool(row.disabled) ?? false,
  };
}

export function transformStatus(value: unknown): StatusRow | null {
  return readStatus(value);
}

export function transformIssueType(value: unknown): IssueTypeRow | null {
  return readIssueType(value);
}

export function transformPriority(value: unknown, sortOrder: number): PriorityRow | null {
  return readPriority(value, sortOrder);
}

export function transformLinkType(value: unknown): LinkTypeRow | null {
  const row = record(value);
  const linkTypeId = integer(row?.id);
  if (!row || linkTypeId === null) return null;
  return {
    link_type_id: linkTypeId,
    name: text(row.name),
    outward: text(row.outward),
    inward: text(row.inward),
  };
}

export function transformProject(value: unknown): ProjectRow | null {
  return readProject(value);
}

export function transformBoard(value: unknown, filterJql: string | null): BoardRow | null {
  const row = record(value);
  const boardId = integer(row?.id);
  if (!row || boardId === null) return null;
  const location = record(row.location);
  return {
    board_id: boardId,
    name: text(row.name),
    board_type: text(row.type),
    location_project_id: integer(location?.projectId),
    filter_jql: filterJql,
  };
}

export function transformSprint(value: unknown): SprintRow | null {
  return readSprint(value);
}

/** Parse a Jira timestamp, including offsets written as +0530. */
export function parseJiraTimestamp(value: string): Date {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error("bad timestamp");
  return parsed;
}

/** Format an instant as yyyy-MM-dd HH:mm in an IANA time zone. */
export function formatJqlTimestamp(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const take = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = take("hour");
  if (hour === "24") hour = "00";
  return `${take("year")}-${take("month")}-${take("day")} ${hour}:${take("minute")}`;
}

/**
 * Incremental search. The bound is the cursor minus 15 minutes, formatted in the
 * Jira account time zone. Jira treats that wall time as the account zone.
 */
export function buildIncrementalJql(cursorIso: string, timeZone: string, overlapMinutes = 15): string {
  const since = new Date(parseJiraTimestamp(cursorIso).getTime() - overlapMinutes * 60_000);
  const stamp = formatJqlTimestamp(since, timeZone);
  return `project = SPEND AND updated >= "${stamp}" ORDER BY updated ASC`;
}

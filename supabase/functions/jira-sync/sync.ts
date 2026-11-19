/**
 * Backfill, incremental, nightly, and rebuild runs.
 * Each invocation stops starting new pages after about 100 seconds and keeps its checkpoint.
 */

import {
  applyIssuePage,
  asId,
  beginBatch,
  connect,
  countLiveIssues,
  finishRun,
  insertRun,
  instant,
  lockRawIssueBatch,
  maxRawUpdated,
  markDeletions,
  publishCleaningVersion,
  readCheckpoint,
  readRawChildren,
  readReference,
  readUserAccountIds,
  type Db,
  type IssuePage,
  type RawChildWrite,
  type ReferencePage,
  type RunCounts,
  writeCheckpoint,
  writeIssuePage,
  writeReferencePage,
} from "./db.ts";
import { decideDeletionGuard } from "./guard.ts";
import { JiraClient } from "./jira.ts";
import { releaseLease, takeLease } from "./lock.ts";
import {
  buildIncrementalJql,
  dedupeUsers,
  parseJiraTimestamp,
  stripEmailAddresses,
  transformBoard,
  transformField,
  transformFieldOption,
  transformIssue,
  transformIssueType,
  transformLinkType,
  transformPriority,
  transformProject,
  transformSprint,
  transformStatus,
  transformUserBulk,
  type IssueBundle,
  type SprintRow,
  type UserRow,
} from "./transform.ts";
import { stampForCleanWrite } from "./version.ts";

const BUDGET_MS = 100_000;
// Write time dominates each batch. A larger batch spends less of the budget on round trips.
const CLEAN_BATCH = 400;
const USER_BULK_CHUNK = 200;
const BACKFILL_JQL = "project = SPEND ORDER BY key ASC";
const ID_JQL = "project = SPEND ORDER BY key ASC";

export type Mode = "backfill" | "incremental" | "nightly" | "rebuild";

export interface RunResult {
  done: boolean;
  status: "ok" | "partial" | "skipped" | "error";
  counts: RunCounts;
  requests: number;
  error?: string;
  warning?: string | null;
}

function emptyCounts(): RunCounts {
  return { issues: 0, comments: 0, worklogs: 0, changelogs: 0, pages: 0 };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const id of value) {
    if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
    else if (typeof id === "string" && /^-?\d+$/.test(id)) ids.push(Number(id));
  }
  return ids;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return parseJiraTimestamp(right).getTime() >= parseJiraTimestamp(left).getTime() ? right : left;
}

function scrub(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .slice(0, 300);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  if (typeof error === "object" && error !== null && "code" in error) {
    const row = error as { code: unknown; routine?: unknown; constraint?: unknown; table?: unknown };
    if (typeof row.code === "string" && /^[0-9A-Z]{5}$/.test(row.code)) {
      const detail = [row.routine, row.constraint, row.table]
        .filter((part): part is string => typeof part === "string" && /^[A-Za-z0-9_]+$/.test(part))
        .join(" ");
      const cause = scrub(message);
      const head = detail ? `database error ${row.code} ${detail}` : `database error ${row.code}`;
      return cause ? `${head}: ${cause}` : head;
    }
  }
  const cause = scrub(message);
  return cause || "sync failed";
}

function groupByIssue(rows: Array<{ issue_id: unknown; payload: unknown }>): Map<number, unknown[]> {
  const grouped = new Map<number, unknown[]>();
  for (const row of rows) {
    const issueId = asId(row.issue_id);
    const list = grouped.get(issueId) ?? [];
    list.push(row.payload);
    grouped.set(issueId, list);
  }
  return grouped;
}

function blankReference(): ReferencePage {
  return {
    raw: [],
    projects: [],
    issueTypes: [],
    statuses: [],
    priorities: [],
    linkTypes: [],
    boards: [],
    sprints: [],
    fields: [],
    options: [],
    users: [],
  };
}

function dedupeHistories(histories: unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const history of histories) {
    const id = record(history)?.id;
    const key = typeof id === "string" || typeof id === "number" ? String(id) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(history);
  }
  return unique;
}

function childRow(value: unknown, issueId: number): RawChildWrite | null {
  const row = record(value);
  const id = row?.id;
  const parsed = typeof id === "number" ? id : typeof id === "string" && /^-?\d+$/.test(id) ? Number(id) : null;
  if (parsed === null) return null;
  return { id: parsed, issue_id: issueId, payload: stripEmailAddresses(value) };
}

async function pageDetails(
  client: JiraClient,
  issues: unknown[],
): Promise<{
  comments: Map<string, unknown[]>;
  worklogs: Map<string, unknown[]>;
  histories: Map<string, unknown[]>;
}> {
  const ids = issues.map((issue) => String(record(issue)?.id ?? ""));
  const comments = new Map<string, unknown[]>();
  const worklogs = new Map<string, unknown[]>();
  const historyPromise = client.fetchChangelogs(ids.filter((id) => id.length > 0));
  await Promise.all(issues.map(async (issue) => {
    const row = record(issue);
    const id = String(row?.id ?? "");
    const fields = record(row?.fields);
    const [fullComments, fullWorklogs] = await Promise.all([
      client.fullComments(id, fields?.comment),
      client.fullWorklogs(id, fields?.worklog),
    ]);
    comments.set(id, fullComments.map((item) => stripEmailAddresses(item)));
    worklogs.set(id, fullWorklogs.map((item) => stripEmailAddresses(item)));
  }));
  const histories = await historyPromise;
  for (const [issueId, rows] of histories) {
    histories.set(issueId, dedupeHistories(rows).map((item) => stripEmailAddresses(item)));
  }
  return { comments, worklogs, histories };
}

function bundlePage(
  issues: unknown[],
  details: {
    comments: Map<string, unknown[]>;
    worklogs: Map<string, unknown[]>;
    histories: Map<string, unknown[]>;
  },
  project: ReturnType<typeof transformProject>,
  checkpointMode: string,
  checkpoint: unknown,
  sprintConflict: "update" | "ignore",
): IssuePage {
  const bundles: IssueBundle[] = [];
  const rawIssues: IssuePage["rawIssues"] = [];
  const rawComments: RawChildWrite[] = [];
  const rawWorklogs: RawChildWrite[] = [];
  const rawHistories: RawChildWrite[] = [];
  for (const issue of issues) {
    const stripped = stripEmailAddresses(issue);
    const row = record(stripped);
    const issueId = typeof row?.id === "string" || typeof row?.id === "number" ? String(row.id) : "";
    const parsedId = typeof row?.id === "number"
      ? row.id
      : typeof row?.id === "string" && /^-?\d+$/.test(row.id) ? Number(row.id) : null;
    const comments = details.comments.get(issueId) ?? [];
    const worklogs = details.worklogs.get(issueId) ?? [];
    const histories = details.histories.get(issueId) ?? [];
    const bundle = transformIssue({ issue: stripped, comments, worklogs, histories });
    if (!bundle || parsedId === null) throw new Error("GET /rest/api/3/search/jql failed with incomplete payload");
    bundles.push(bundle);
    const fields = record(row?.fields);
    rawIssues.push({
      issue_id: parsedId,
      issue_key: bundle.issue.issue_key,
      payload: stripped,
      jira_updated_at: text(fields?.updated),
    });
    for (const comment of comments) {
      const child = childRow(comment, parsedId);
      if (child) rawComments.push(child);
    }
    for (const worklog of worklogs) {
      const child = childRow(worklog, parsedId);
      if (child) rawWorklogs.push(child);
    }
    for (const history of histories) {
      const child = childRow(history, parsedId);
      if (child) rawHistories.push(child);
    }
  }
  const users: UserRow[] = [];
  const sprints: SprintRow[] = [];
  for (const bundle of bundles) {
    users.push(...bundle.users);
    sprints.push(...bundle.sprints);
  }
  if (project) {
    for (const bundle of bundles) bundle.project = project;
  }
  return {
    issueIds: bundles.map((bundle) => bundle.issue.issue_id),
    rawIssues,
    rawComments,
    rawWorklogs,
    rawHistories,
    projects: bundles.flatMap((bundle) => bundle.project ? [bundle.project] : []),
    issueTypes: bundles.flatMap((bundle) => bundle.issueType ? [bundle.issueType] : []),
    statuses: bundles.flatMap((bundle) => bundle.status ? [bundle.status] : []),
    priorities: bundles.flatMap((bundle) => bundle.priority ? [bundle.priority] : []),
    teams: bundles.flatMap((bundle) => bundle.team ? [bundle.team] : []),
    users: dedupeUsers(users),
    linkTypes: bundles.flatMap((bundle) => bundle.linkTypes),
    sprints,
    issues: bundles.map((bundle) => bundle.issue),
    comments: bundles.flatMap((bundle) => bundle.comments),
    changes: bundles.flatMap((bundle) => bundle.changes),
    worklogs: bundles.flatMap((bundle) => bundle.worklogs),
    attachments: bundles.flatMap((bundle) => bundle.attachments),
    links: bundles.flatMap((bundle) => bundle.links),
    issueSprints: bundles.flatMap((bundle) => bundle.issueSprints),
    sprintConflict,
    writeRaw: true,
    transformVersion: stampForCleanWrite(),
    checkpointMode,
    checkpoint,
  };
}

async function rememberProject(db: Db, client: JiraClient): Promise<ReturnType<typeof transformProject>> {
  const payload = stripEmailAddresses(await client.get("/rest/api/3/project/SPEND"));
  const project = transformProject(payload);
  if (!project) throw new Error("GET /rest/api/3/project/SPEND failed with incomplete payload");
  const reference = blankReference();
  reference.raw.push({ kind: "project", ref_id: String(project.project_id), payload });
  reference.projects.push(project);
  await writeReferencePage(db, reference);
  return project;
}

async function searchUntilBudget(
  db: Db,
  client: JiraClient,
  mode: "backfill" | "incremental",
  jql: string,
  token: string | null,
  project: ReturnType<typeof transformProject>,
  deadline: number,
  checkpointFor: (page: { isLast: boolean; nextPageToken: string | null }, maxUpdated: string | null) => unknown,
): Promise<{ done: boolean; counts: RunCounts; maxUpdated: string | null }> {
  const counts = emptyCounts();
  let maxUpdated: string | null = null;
  let nextToken = token;
  while (Date.now() < deadline) {
    const page = await client.searchPage(jql, "*all", nextToken);
    if (!page.isLast && !page.nextPageToken) {
      throw new Error("GET /rest/api/3/search/jql failed with no page token");
    }
    for (const issue of page.issues) {
      maxUpdated = laterTimestamp(maxUpdated, text(record(record(issue)?.fields)?.updated));
    }
    const details = page.issues.length === 0
      ? { comments: new Map<string, unknown[]>(), worklogs: new Map<string, unknown[]>(), histories: new Map<string, unknown[]>() }
      : await pageDetails(client, page.issues);
    const written = bundlePage(
      page.issues,
      details,
      project,
      mode,
      checkpointFor(page, maxUpdated),
      "update",
    );
    await writeIssuePage(db, written);
    counts.pages = (counts.pages ?? 0) + 1;
    counts.issues = (counts.issues ?? 0) + page.issues.length;
    counts.comments = (counts.comments ?? 0) + written.comments.length;
    counts.worklogs = (counts.worklogs ?? 0) + written.worklogs.length;
    counts.changelogs = (counts.changelogs ?? 0) + written.rawHistories.length;
    console.log(`jira-sync ${mode} page issues=${page.issues.length} requests=${client.requests}`);
    if (page.isLast) return { done: true, counts, maxUpdated };
    nextToken = page.nextPageToken;
  }
  return { done: false, counts, maxUpdated };
}

async function runBackfill(db: Db, client: JiraClient, deadline: number): Promise<RunResult> {
  const state = await readCheckpoint(db, "backfill");
  if (state.complete === true) {
    return { done: true, status: "ok", counts: emptyCounts(), requests: client.requests };
  }
  const project = await rememberProject(db, client);
  const token = text(state.nextPageToken);
  const outcome = await searchUntilBudget(
    db,
    client,
    "backfill",
    BACKFILL_JQL,
    token,
    project,
    deadline,
    (page) => page.isLast ? { complete: true } : { complete: false, nextPageToken: page.nextPageToken },
  );
  return {
    done: outcome.done,
    status: outcome.done ? "ok" : "partial",
    counts: outcome.counts,
    requests: client.requests,
  };
}

async function runIncremental(db: Db, client: JiraClient, deadline: number): Promise<RunResult> {
  const state = await readCheckpoint(db, "incremental");
  const project = await rememberProject(db, client);
  const storedCursor = text(state.cursor) ?? await maxRawUpdated(db) ?? new Date().toISOString();
  let jql = text(state.pendingJql);
  let token = text(state.nextPageToken);
  if (state.inProgress !== true || !jql) {
    const zone = await client.timeZone();
    const reference = blankReference();
    reference.raw.push({ kind: "myself", ref_id: "self", payload: { timeZone: zone } });
    await writeReferencePage(db, reference);
    jql = buildIncrementalJql(storedCursor, zone);
    token = null;
  }
  const outcome = await searchUntilBudget(
    db,
    client,
    "incremental",
    jql,
    token,
    project,
    deadline,
    (page, seen) => {
      const cursor = laterTimestamp(storedCursor, seen) ?? storedCursor;
      if (page.isLast) return { cursor, inProgress: false };
      return {
        cursor: storedCursor,
        inProgress: true,
        pendingJql: jql,
        nextPageToken: page.nextPageToken,
        maxUpdated: seen,
      };
    },
  );
  if (!outcome.done) {
    return {
      done: false,
      status: "partial",
      counts: outcome.counts,
      requests: client.requests,
    };
  }
  const recleaned = await drainOutdated(db, deadline);
  return {
    done: true,
    status: "ok",
    counts: { ...outcome.counts, recleaned },
    requests: client.requests,
  };
}

async function fetchUserBulk(client: JiraClient, accountIds: string[]): Promise<unknown[]> {
  const found: unknown[] = [];
  for (let offset = 0; offset < accountIds.length; offset += USER_BULK_CHUNK) {
    const chunk = accountIds.slice(offset, offset + USER_BULK_CHUNK);
    const params = chunk.map((id) => `accountId=${encodeURIComponent(id)}`).join("&");
    let startAt = 0;
    for (;;) {
      const body = record(await client.get(
        `/rest/api/3/user/bulk?${params}&startAt=${startAt}&maxResults=${USER_BULK_CHUNK}`,
      ));
      const values = Array.isArray(body?.values) ? body.values : [];
      found.push(...values);
      const total = typeof body?.total === "number" ? body.total : values.length;
      startAt += values.length;
      if (body?.isLast === true || values.length === 0 || startAt >= total) break;
    }
  }
  return found;
}

async function loadReference(db: Db, client: JiraClient): Promise<ReferencePage> {
  const page = blankReference();
  const projectPayload = stripEmailAddresses(await client.get("/rest/api/3/project/SPEND"));
  const project = transformProject(projectPayload);
  if (project) {
    page.projects.push(project);
    page.raw.push({ kind: "project", ref_id: String(project.project_id), payload: projectPayload });
  }
  const zone = await client.timeZone();
  page.raw.push({ kind: "myself", ref_id: "self", payload: { timeZone: zone } });

  const fields = await client.get("/rest/api/3/field");
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const row = transformField(field);
      if (!row) continue;
      page.fields.push(row);
      page.raw.push({ kind: "field", ref_id: row.field_id, payload: stripEmailAddresses(field) });
    }
  }

  const statuses = await client.get("/rest/api/3/status");
  if (Array.isArray(statuses)) {
    for (const status of statuses) {
      const row = transformStatus(status);
      if (!row) continue;
      page.statuses.push(row);
      page.raw.push({ kind: "status", ref_id: String(row.status_id), payload: stripEmailAddresses(status) });
    }
  }

  const issueTypes = await client.get("/rest/api/3/issuetype/project?projectId=10014");
  const typeIds: string[] = [];
  if (Array.isArray(issueTypes)) {
    for (const issueType of issueTypes) {
      const row = transformIssueType(issueType);
      if (!row) continue;
      page.issueTypes.push(row);
      typeIds.push(String(row.issue_type_id));
      page.raw.push({ kind: "issue_type", ref_id: String(row.issue_type_id), payload: stripEmailAddresses(issueType) });
    }
  }

  const priorities = await client.get("/rest/api/3/priority");
  if (Array.isArray(priorities)) {
    const ids: string[] = [];
    for (let index = 0; index < priorities.length; index += 1) {
      const priority = priorities[index];
      const row = transformPriority(priority, index);
      if (!row) continue;
      page.priorities.push(row);
      ids.push(String(row.priority_id));
      page.raw.push({ kind: "priority", ref_id: String(row.priority_id), payload: stripEmailAddresses(priority) });
    }
    page.raw.push({ kind: "priority_order", ref_id: "order", payload: { ids } });
  }

  const linkTypes = record(await client.get("/rest/api/3/issueLinkType"));
  const linkTypeList = Array.isArray(linkTypes?.issueLinkTypes) ? linkTypes.issueLinkTypes : [];
  for (const linkType of linkTypeList) {
    const row = transformLinkType(linkType);
    if (!row) continue;
    page.linkTypes.push(row);
    page.raw.push({ kind: "link_type", ref_id: String(row.link_type_id), payload: stripEmailAddresses(linkType) });
  }

  for (const typeId of typeIds) {
    let startAt = 0;
    for (;;) {
      const body = record(await client.get(
        `/rest/api/3/issue/createmeta/SPEND/issuetypes/${encodeURIComponent(typeId)}?startAt=${startAt}&maxResults=50`,
      ));
      const values = Array.isArray(body?.values) ? body.values : Array.isArray(body?.fields) ? body.fields : [];
      for (const field of values) {
        const fieldRow = record(field);
        const fieldId = text(fieldRow?.fieldId) ?? text(fieldRow?.key);
        const allowed = Array.isArray(fieldRow?.allowedValues) ? fieldRow.allowedValues : [];
        if (!fieldId) continue;
        for (const option of allowed) {
          if (typeof record(option)?.value !== "string") continue;
          const row = transformFieldOption(fieldId, option);
          if (!row) continue;
          page.options.push(row);
          page.raw.push({
            kind: "field_option",
            ref_id: `${fieldId}:${row.option_id}`,
            payload: stripEmailAddresses(option),
          });
        }
      }
      const total = typeof body?.total === "number" ? body.total : values.length;
      startAt += values.length;
      if (values.length === 0 || startAt >= total) break;
    }
  }

  let boardStart = 0;
  const boards: unknown[] = [];
  for (;;) {
    const body = record(await client.get(`/rest/agile/1.0/board?projectKeyOrId=SPEND&startAt=${boardStart}&maxResults=50`));
    const values = Array.isArray(body?.values) ? body.values : [];
    boards.push(...values);
    const total = typeof body?.total === "number" ? body.total : values.length;
    boardStart += values.length;
    if (body?.isLast === true || values.length === 0 || boardStart >= total) break;
  }
  for (const board of boards) {
    const boardId = record(board)?.id;
    if (typeof boardId !== "number" && typeof boardId !== "string") continue;
    const configuration = record(await client.get(`/rest/agile/1.0/board/${boardId}/configuration`));
    const filterId = record(configuration?.filter)?.id;
    let filterJql: string | null = null;
    if (typeof filterId === "string" || typeof filterId === "number") {
      const filter = record(await client.get(`/rest/api/3/filter/${filterId}`));
      filterJql = text(filter?.jql);
    }
    const stored = stripEmailAddresses(board);
    const storedRow = record(stored);
    if (storedRow) storedRow.filterJql = filterJql;
    const row = transformBoard(stored, filterJql);
    if (!row) continue;
    page.boards.push(row);
    page.raw.push({ kind: "board", ref_id: String(row.board_id), payload: stored });
    let sprintStart = 0;
    for (;;) {
      let body: Record<string, unknown> | null = null;
      try {
        body = record(await client.get(`/rest/agile/1.0/board/${boardId}/sprint?startAt=${sprintStart}&maxResults=50`));
      } catch (error) {
        if (error instanceof Error && /failed with 40[04]/.test(error.message)) break;
        throw error;
      }
      const values = Array.isArray(body?.values) ? body.values : [];
      for (const sprint of values) {
        const sprintRow = transformSprint(sprint);
        if (!sprintRow) continue;
        page.sprints.push(sprintRow);
        page.raw.push({ kind: "sprint", ref_id: String(sprintRow.sprint_id), payload: stripEmailAddresses(sprint) });
      }
      const total = typeof body?.total === "number" ? body.total : values.length;
      sprintStart += values.length;
      if (body?.isLast === true || values.length === 0 || sprintStart >= total) break;
    }
  }

  const accountIds = await readUserAccountIds(db);
  if (accountIds.length > 0) {
    const users = transformUserBulk(await fetchUserBulk(client, accountIds));
    page.users.push(...users.users);
    page.raw.push(...users.raw);
  }
  return page;
}

async function runNightly(db: Db, client: JiraClient, deadline: number): Promise<RunResult> {
  const state = await readCheckpoint(db, "nightly");
  const counts = emptyCounts();
  let seen = idList(state.seenIds);
  let token = text(state.nextPageToken);
  const resuming = state.inProgress === true && state.phase === "ids";
  if (!resuming) {
    const reference = await loadReference(db, client);
    counts.pages = reference.fields.length;
    await writeReferencePage(db, {
      ...reference,
      checkpointMode: "nightly",
      checkpoint: { inProgress: true, phase: "ids", seenIds: [], nextPageToken: null },
    });
    seen = [];
    token = null;
  }
  while (Date.now() < deadline) {
    const page = await client.searchPage(ID_JQL, "id", token);
    if (!page.isLast && !page.nextPageToken) {
      throw new Error("GET /rest/api/3/search/jql failed with no page token");
    }
    for (const issue of page.issues) {
      const id = record(issue)?.id;
      if (typeof id === "number") seen.push(id);
      else if (typeof id === "string" && /^-?\d+$/.test(id)) seen.push(Number(id));
    }
    counts.issues = seen.length;
    if (page.isLast) {
      const ids = [...new Set(seen)];
      const live = await countLiveIssues(db);
      const decision = decideDeletionGuard(ids.length, live);
      await markDeletions(db, ids, decision.markMissing);
      await writeCheckpoint(db, "nightly", { inProgress: false });
      counts.issues = ids.length;
      counts.jira_ids = ids.length;
      counts.live_issues = live;
      console.log(
        decision.warning
          ? `jira-sync nightly ${decision.warning}`
          : `jira-sync nightly issues=${ids.length} requests=${client.requests}`,
      );
      return { done: true, status: "ok", counts, requests: client.requests, warning: decision.warning };
    }
    token = page.nextPageToken;
    await writeCheckpoint(db, "nightly", { inProgress: true, phase: "ids", seenIds: seen, nextPageToken: token });
  }
  return { done: false, status: "partial", counts, requests: client.requests };
}

function referenceFromRaw(rows: Array<{ kind: string; ref_id: string; payload: unknown }>): ReferencePage {
  const page = blankReference();
  const priorityOrder = rows.find((row) => row.kind === "priority_order")?.payload;
  const order = record(priorityOrder);
  const ids = Array.isArray(order?.ids) ? order.ids.map((id) => String(id)) : [];
  const sort = new Map(ids.map((id, index) => [id, index]));
  for (const row of rows) {
    if (row.kind === "project") {
      const project = transformProject(row.payload);
      if (project) page.projects.push(project);
    } else if (row.kind === "field") {
      const field = transformField(row.payload);
      if (field) page.fields.push(field);
    } else if (row.kind === "field_option") {
      const splitAt = row.ref_id.indexOf(":");
      if (splitAt <= 0) continue;
      const option = transformFieldOption(row.ref_id.slice(0, splitAt), row.payload);
      if (option) page.options.push(option);
    } else if (row.kind === "status") {
      const status = transformStatus(row.payload);
      if (status) page.statuses.push(status);
    } else if (row.kind === "issue_type") {
      const issueType = transformIssueType(row.payload);
      if (issueType) page.issueTypes.push(issueType);
    } else if (row.kind === "priority") {
      const priority = transformPriority(row.payload, sort.get(row.ref_id) ?? 0);
      if (priority) page.priorities.push(priority);
    } else if (row.kind === "link_type") {
      const linkType = transformLinkType(row.payload);
      if (linkType) page.linkTypes.push(linkType);
    } else if (row.kind === "board") {
      const board = transformBoard(row.payload, text(record(row.payload)?.filterJql));
      if (board) page.boards.push(board);
    } else if (row.kind === "sprint") {
      const sprint = transformSprint(row.payload);
      if (sprint) page.sprints.push(sprint);
    } else if (row.kind === "user") {
      const user = transformUserBulk([row.payload]).users[0];
      if (user) page.users.push(user);
    }
  }
  return page;
}

interface CleanBatchStats {
  issues: number;
  comments: number;
  worklogs: number;
  changelogs: number;
  readMs: number;
  transformMs: number;
  writeMs: number;
  payloadBytes: number;
  lastIssueId: number | null;
}

function pageFromBundles(
  bundles: IssueBundle[],
  issueIds: number[],
  checkpointMode: string | null,
  checkpoint: unknown,
): IssuePage {
  const users: UserRow[] = [];
  for (const bundle of bundles) users.push(...bundle.users);
  return {
    issueIds,
    rawIssues: [],
    rawComments: [],
    rawWorklogs: [],
    rawHistories: [],
    projects: bundles.flatMap((bundle) => bundle.project ? [bundle.project] : []),
    issueTypes: bundles.flatMap((bundle) => bundle.issueType ? [bundle.issueType] : []),
    statuses: bundles.flatMap((bundle) => bundle.status ? [bundle.status] : []),
    priorities: bundles.flatMap((bundle) => bundle.priority ? [bundle.priority] : []),
    teams: bundles.flatMap((bundle) => bundle.team ? [bundle.team] : []),
    users: dedupeUsers(users),
    linkTypes: bundles.flatMap((bundle) => bundle.linkTypes),
    sprints: bundles.flatMap((bundle) => bundle.sprints),
    issues: bundles.map((bundle) => bundle.issue),
    comments: bundles.flatMap((bundle) => bundle.comments),
    changes: bundles.flatMap((bundle) => bundle.changes),
    worklogs: bundles.flatMap((bundle) => bundle.worklogs),
    attachments: bundles.flatMap((bundle) => bundle.attachments),
    links: bundles.flatMap((bundle) => bundle.links),
    issueSprints: bundles.flatMap((bundle) => bundle.issueSprints),
    sprintConflict: "ignore",
    writeRaw: false,
    transformVersion: stampForCleanWrite(),
    checkpointMode,
    checkpoint,
  };
}

function addTiming(counts: RunCounts, batch: CleanBatchStats): void {
  counts.read_ms = (counts.read_ms ?? 0) + batch.readMs;
  counts.transform_ms = (counts.transform_ms ?? 0) + batch.transformMs;
  counts.write_ms = (counts.write_ms ?? 0) + batch.writeMs;
  counts.payload_bytes = (counts.payload_bytes ?? 0) + batch.payloadBytes;
}

async function oneCleanBatch(
  db: Db,
  select: { kind: "after"; afterId: number; limit: number } | { kind: "outdated"; version: number; limit: number },
  checkpointMode: "rebuild" | null,
): Promise<CleanBatchStats> {
  return await beginBatch(db, async (tx) => {
    const readStarted = performance.now();
    const locked = await lockRawIssueBatch(tx, select);
    const issueIds = locked.map((row) => asId(row.issue_id));
    const payloadBytes = locked.reduce((sum, row) => sum + asId(row.payload_bytes), 0);
    const readChildren = async () => {
      const comments = await readRawChildren(tx, "jira_comment_raw", "comment_id", issueIds);
      const worklogs = await readRawChildren(tx, "jira_worklog_raw", "worklog_id", issueIds);
      const histories = await readRawChildren(tx, "jira_changelog_raw", "history_id", issueIds);
      return { comments, worklogs, histories };
    };
    if (issueIds.length === 0) {
      const readMs = Math.round(performance.now() - readStarted);
      if (checkpointMode) await writeCheckpoint(tx, checkpointMode, { inProgress: false });
      return {
        issues: 0,
        comments: 0,
        worklogs: 0,
        changelogs: 0,
        readMs,
        transformMs: 0,
        writeMs: 0,
        payloadBytes: 0,
        lastIssueId: null,
      };
    }
    const children = await readChildren();
    const readMs = Math.round(performance.now() - readStarted);
    const transformStarted = performance.now();
    const commentMap = groupByIssue(children.comments);
    const worklogMap = groupByIssue(children.worklogs);
    const historyMap = groupByIssue(children.histories);
    const bundles: IssueBundle[] = [];
    for (const row of locked) {
      const issueId = asId(row.issue_id);
      const bundle = transformIssue({
        issue: row.payload,
        comments: commentMap.get(issueId) ?? [],
        worklogs: worklogMap.get(issueId) ?? [],
        histories: historyMap.get(issueId) ?? [],
        deletedAt: instant(row.deleted_at),
      });
      if (!bundle) throw new Error("GET /rest/api/3/search/jql failed with incomplete payload");
      bundles.push(bundle);
    }
    const transformMs = Math.round(performance.now() - transformStarted);
    const lastIssueId = issueIds[issueIds.length - 1] ?? null;
    const page = pageFromBundles(
      bundles,
      issueIds,
      checkpointMode,
      checkpointMode ? { inProgress: true, lastIssueId } : null,
    );
    const writeStarted = performance.now();
    await applyIssuePage(tx, page);
    const writeMs = Math.round(performance.now() - writeStarted);
    return {
      issues: bundles.length,
      comments: bundles.reduce((sum, bundle) => sum + bundle.comments.length, 0),
      worklogs: bundles.reduce((sum, bundle) => sum + bundle.worklogs.length, 0),
      changelogs: bundles.reduce((sum, bundle) => sum + bundle.changes.length, 0),
      readMs,
      transformMs,
      writeMs,
      payloadBytes,
      lastIssueId,
    };
  });
}

async function drainOutdated(db: Db, deadline: number): Promise<number> {
  if (Date.now() >= deadline) {
    console.log("jira-sync drain skipped budget");
    return 0;
  }
  const owner = crypto.randomUUID();
  const locked = await takeLease(db, "rebuild", owner);
  if (!locked) {
    console.log("jira-sync drain skipped rebuild lease held");
    return 0;
  }
  try {
    let recleaned = 0;
    while (Date.now() < deadline) {
      const batch = await oneCleanBatch(
        db,
        { kind: "outdated", version: stampForCleanWrite(), limit: CLEAN_BATCH },
        null,
      );
      if (batch.issues === 0) break;
      recleaned += batch.issues;
      console.log(
        `jira-sync drain batch issues=${batch.issues} read_ms=${batch.readMs} transform_ms=${batch.transformMs} write_ms=${batch.writeMs} payload_bytes=${batch.payloadBytes} recleaned=${recleaned}`,
      );
    }
    console.log(`jira-sync drain recleaned=${recleaned}`);
    return recleaned;
  } finally {
    await releaseLease(db, "rebuild", owner);
  }
}

async function runRebuild(db: Db, deadline: number): Promise<RunResult> {
  const state = await readCheckpoint(db, "rebuild");
  const counts = emptyCounts();
  let afterId = 0;
  if (state.inProgress === true && (typeof state.lastIssueId === "number" || typeof state.lastIssueId === "string")) {
    afterId = asId(state.lastIssueId);
  } else {
    const referenceStarted = performance.now();
    await writeReferencePage(db, referenceFromRaw(await readReference(db)));
    counts.reference_ms = Math.round(performance.now() - referenceStarted);
    console.log(`jira-sync rebuild reference_ms=${counts.reference_ms}`);
  }
  while (Date.now() < deadline) {
    const batch = await oneCleanBatch(db, { kind: "after", afterId, limit: CLEAN_BATCH }, "rebuild");
    addTiming(counts, batch);
    if (batch.issues === 0) return { done: true, status: "ok", counts, requests: 0 };
    counts.pages = (counts.pages ?? 0) + 1;
    counts.issues = (counts.issues ?? 0) + batch.issues;
    counts.comments = (counts.comments ?? 0) + batch.comments;
    counts.worklogs = (counts.worklogs ?? 0) + batch.worklogs;
    counts.changelogs = (counts.changelogs ?? 0) + batch.changelogs;
    afterId = batch.lastIssueId ?? afterId;
    console.log(
      `jira-sync rebuild batch issues=${batch.issues} read_ms=${batch.readMs} transform_ms=${batch.transformMs} write_ms=${batch.writeMs} payload_bytes=${batch.payloadBytes}`,
    );
  }
  return { done: false, status: "partial", counts, requests: 0 };
}

async function execute(db: Db, mode: Mode, deadline: number): Promise<RunResult> {
  if (mode === "rebuild") return await runRebuild(db, deadline);
  const client = JiraClient.fromEnv();
  if (mode === "backfill") return await runBackfill(db, client, deadline);
  if (mode === "incremental") return await runIncremental(db, client, deadline);
  return await runNightly(db, client, deadline);
}

/** Take the lease, run one mode, and always release the lease. */
export async function runSync(mode: Mode): Promise<RunResult> {
  const db = connect();
  const owner = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let runId: string | null = null;
  let locked = false;
  try {
    await publishCleaningVersion(db, stampForCleanWrite());
    locked = await takeLease(db, mode, owner);
    if (!locked) {
      runId = await insertRun(db, mode, startedAt);
      await finishRun(db, runId, "skipped", {}, 0, null);
      return { done: false, status: "skipped", counts: {}, requests: 0 };
    }
    runId = await insertRun(db, mode, startedAt);
    const result = await execute(db, mode, Date.now() + BUDGET_MS);
    await finishRun(db, runId, result.status, result.counts, result.requests, null, result.warning ?? null);
    return result;
  } catch (error) {
    const message = safeMessage(error);
    try {
      if (!runId) runId = await insertRun(db, mode, startedAt);
      await finishRun(db, runId, "error", {}, 0, message);
    } catch {
      // The failed run is still visible if the insert landed.
    }
    return { done: false, status: "error", counts: {}, requests: 0, error: message };
  } finally {
    if (locked) {
      try {
        await releaseLease(db, mode, owner);
      } catch {
        // The lease expires on its own.
      }
    }
    try {
      await db.end();
    } catch {
      // The connection is process-local.
    }
  }
}

import { stripEmailAddresses, transformIssue, transformUserBulk } from "./transform.ts";

const EMAIL = "hidden@example.com";

function issueFixture(): unknown {
  return {
    id: "12699",
    key: "SPEND-1",
    fields: {
      summary: " Example ",
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      },
      issuetype: { id: "10061", name: "Bug", hierarchyLevel: 0, subtask: false },
      project: { id: "10014", key: "SPEND", name: "AiA", projectTypeKey: "software", style: "next-gen" },
      parent: { id: "999", key: "SPEND-PARENT" },
      status: { id: "10067", name: "Done", statusCategory: { key: "done", name: "Done" } },
      resolution: { id: "10000", name: "Done" },
      priority: { id: "3", name: "Medium" },
      customfield_10021: [{ id: "1", value: "Impediment" }],
      assignee: {
        accountId: "assignee-1",
        displayName: "Ada",
        accountType: "atlassian",
        active: true,
        timeZone: "Asia/Calcutta",
        emailAddress: EMAIL,
      },
      reporter: null,
      creator: {
        accountId: "creator-1",
        displayName: "Cam",
        accountType: "atlassian",
        active: true,
        emailAddress: EMAIL,
      },
      customfield_10001: { id: "team-1", name: "AI Team" },
      created: "2024-04-18T18:07:25.000+0530",
      updated: "2026-11-18T19:04:37.000+0530",
      resolutiondate: "2026-01-01T00:00:00.000+0530",
      statuscategorychangedate: "2026-01-02T00:00:00.000+0530",
      duedate: "2026-12-01",
      customfield_10015: "2026-11-01",
      customfield_10016: -1,
      timeoriginalestimate: 3600,
      timeestimate: 1800,
      timespent: 600,
      customfield_10832: { id: "1", value: " AP " },
      customfield_10585: ["GstRecon", " Banking "],
      customfield_10618: ["sycn", "DataSync"],
      customfield_10833: { id: "2", value: "Inbox" },
      customfield_10831: { id: "3", value: " UAT" },
      environment: "Production",
      customfield_10794: ["L1"],
      customfield_10796: ["Customer_infra"],
      customfield_10795: ["QA", "Product"],
      customfield_10797: ["QA", "Other"],
      labels: ["form"],
      comment: { total: 2, comments: [] },
      attachment: [{
        id: "5",
        filename: "a.png",
        mimeType: "image/png",
        size: 10,
        created: "2026-01-01T00:00:00.000+0530",
        content: "https://example.test/a",
        author: { accountId: "assignee-1", displayName: "Ada", emailAddress: EMAIL },
      }],
      watches: { watchCount: 3 },
      issuelinks: [{
        id: "50",
        type: { id: "10000", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
        outwardIssue: { id: "60", key: "KOR-1" },
      }],
      customfield_10020: [{
        id: 10,
        name: "SPEND Sprint 1",
        state: "closed",
        boardId: 10,
        startDate: "2024-06-21T00:00:00.000+0530",
        endDate: "2024-08-30T00:00:00.000+0530",
        goal: "",
      }],
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("issue transform maps fields and keeps the two Module fields apart", () => {
  const bundle = transformIssue({
    issue: issueFixture(),
    comments: [],
    worklogs: [],
    histories: [],
  });
  assert(bundle, "bundle");
  const issue = bundle.issue;
  assert(issue.issue_id === 12699, "id");
  assert(issue.issue_key === "SPEND-1", "key");
  assert(issue.project_id === 10014, "project");
  assert(issue.summary === "Example", "summary trimmed");
  assert(issue.description_text === "Hello", "description");
  assert(issue.issue_type_id === 10061, "type");
  assert(issue.parent_issue_id === 999, "parent");
  assert(issue.status_id === 10067, "status");
  assert(issue.resolution === "Done", "resolution");
  assert(issue.priority_id === 3, "priority");
  assert(issue.flagged === true, "flagged");
  assert(issue.assignee_account_id === "assignee-1", "assignee");
  assert(issue.reporter_account_id === null, "reporter");
  assert(issue.creator_account_id === "creator-1", "creator");
  assert(issue.team_id === "team-1", "team");
  assert(issue.story_points === -1, "story points stay -1");
  assert(issue.original_estimate_seconds === 3600, "original");
  assert(issue.module === "AP", "select module");
  assert(JSON.stringify(issue.module_tags) === JSON.stringify(["GstRecon", "Banking"]), "label module");
  assert(JSON.stringify(issue.sub_module_tags) === JSON.stringify(["sycn", "DataSync"]), "sycn kept");
  assert(issue.feature === "Inbox", "feature");
  assert(JSON.stringify(issue.root_cause_tags) === JSON.stringify(["Customer_infra"]), "root cause");
  assert(JSON.stringify(issue.labels) === JSON.stringify(["form"]), "labels");
  assert(issue.comment_count === 2, "comment count");
  assert(issue.attachment_count === 1, "attachments");
  assert(issue.watcher_count === 3, "watchers");
  assert(issue.due_date === "2026-12-01", "due");
  assert(issue.start_date === "2026-11-01", "start");
  assert(bundle.project?.style === "next-gen", "style");
  assert(bundle.issueType?.hierarchy_level === 0, "hierarchy");
  assert(bundle.status?.category_key === "done", "category");
  assert(bundle.team?.name === "AI Team", "team name");
  assert(bundle.sprints.length === 1 && bundle.sprints[0].board_id === 10, "sprint");
  assert(bundle.issueSprints.length === 1, "membership");
  assert(bundle.links.length === 1, "link");
  assert(bundle.links[0].outward_issue_key === "KOR-1", "outward key");
  assert(bundle.links[0].inward_issue_key === "SPEND-1", "current issue is inward when outwardIssue is set");
  assert(bundle.attachments[0].filename === "a.png", "filename");
  const assignee = bundle.users.find((user) => user.account_id === "assignee-1");
  assert(assignee?.display_name === "Ada", "name");
  assert(assignee?.time_zone === "Asia/Calcutta", "zone");
  assert(!("email" in (assignee ?? {})), "no email field");
});

Deno.test("environment is the trimmed select, and the system field is ignored", () => {
  const bundle = transformIssue({ issue: issueFixture(), comments: [], worklogs: [], histories: [] });
  assert(bundle?.issue.environment === "UAT", "trimmed UAT");
});

Deno.test("the two Source fields are unioned without dropping duplicates' first copy", () => {
  const bundle = transformIssue({ issue: issueFixture(), comments: [], worklogs: [], histories: [] });
  assert(JSON.stringify(bundle?.issue.source_tags) === JSON.stringify(["QA", "Product", "Other"]), "union");
});

Deno.test("severity stays a single value, or is comma-joined when several are set", () => {
  const single = transformIssue({ issue: issueFixture(), comments: [], worklogs: [], histories: [] });
  assert(single?.issue.severity === "L1", "single");
  const raw = issueFixture() as { fields: { customfield_10794: string[] } };
  raw.fields.customfield_10794 = ["L1", "L2"];
  const many = transformIssue({ issue: raw, comments: [], worklogs: [], histories: [] });
  assert(many?.issue.severity === "L1, L2", "joined");
});

Deno.test("email addresses are stripped from stored payloads and never reach clean rows", () => {
  const raw = issueFixture();
  const stripped = stripEmailAddresses(raw);
  assert(!JSON.stringify(stripped).includes("emailAddress"), "key removed");
  assert(!JSON.stringify(stripped).includes(EMAIL), "value removed");
  const nested = record(record(stripped)?.fields)?.assignee;
  assert(nested && typeof nested === "object" && !("emailAddress" in nested), "assignee object");

  const bundle = transformIssue({
    issue: raw,
    comments: [{
      id: "9",
      author: { accountId: "commenter", displayName: "Pat", emailAddress: EMAIL },
      updateAuthor: { accountId: "commenter", displayName: "Pat", emailAddress: EMAIL },
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Note" }] }] },
      created: "2026-01-01T00:00:00.000+0530",
      updated: "2026-01-01T00:00:00.000+0530",
    }],
    worklogs: [],
    histories: [{
      id: "77",
      created: "2026-01-01T00:00:00.000+0530",
      author: { accountId: "changer", displayName: "Rex", emailAddress: EMAIL },
      items: [{ field: "status", fieldId: "status", fieldtype: "jira", from: "1", fromString: "To Do", to: "2", toString: "Done" }],
    }],
  });
  const encoded = JSON.stringify(bundle);
  assert(!encoded.includes("emailAddress"), "clean has no email key");
  assert(!encoded.includes(EMAIL), "clean has no email value");
  assert(bundle?.comments[0]?.body_text === "Note", "comment text");
  assert(bundle?.changes[0]?.item_index === 0, "item index");
  assert(bundle?.changes[0]?.field_type === "jira", "field type");
  assert(bundle?.changes[0]?.to_display === "Done", "to display");
});

Deno.test("user bulk drops emailAddress and keeps the account fields", () => {
  const bulk = transformUserBulk([
    {
      accountId: "acc-1",
      displayName: "Renamed",
      accountType: "atlassian",
      active: false,
      timeZone: "Asia/Calcutta",
      emailAddress: EMAIL,
      groups: { items: [{ name: "crew", emailAddress: EMAIL }] },
    },
    { displayName: "No account" },
  ]);
  const encoded = JSON.stringify(bulk);
  if (encoded.includes("emailAddress") || encoded.includes(EMAIL)) throw new Error("email survived user bulk");
  if (bulk.raw.length !== 1 || bulk.raw[0]?.kind !== "user" || bulk.raw[0]?.ref_id !== "acc-1") {
    throw new Error("raw user row");
  }
  const user = bulk.users[0];
  if (!user || bulk.users.length !== 1) throw new Error("one user");
  if (user.account_id !== "acc-1" || user.display_name !== "Renamed") throw new Error("name");
  if (user.account_type !== "atlassian" || user.active !== false || user.time_zone !== "Asia/Calcutta") {
    throw new Error("flags");
  }
});

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

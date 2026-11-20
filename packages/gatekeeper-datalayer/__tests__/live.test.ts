// Live suite: a real session against the Data Layer's database, as its read-only login. Runs only
// where DATA_LAYER_DATABASE_URL is set (vitest.config.ts reads the root `.dev.vars`); prints counts
// and shapes, never row contents.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { DataLayer } from "../src/types.js";
import type { DataLayerGatekeeper } from "../src/worker.js";

const live = Boolean(env.DATA_LAYER_DATABASE_URL);

/** A queue that records every observation the session authorizes. */
function recordingQueue() {
  const observations: ObservationDescription[] = [];
  return {
    observations,
    dup() { return this; },
    authorizeObservation(description: ObservationDescription) { observations.push(description); },
    [Symbol.dispose]() {},
  };
}

type Queue = ReturnType<typeof recordingQueue>;

/**
 * Runs `fn` inside a fresh workspace facet with a session on a recording queue, so a refused call
 * rejects right here rather than across the Durable Object's RPC boundary.
 */
function withSession(fn: (session: DataLayer, queue: Queue) => Promise<void>): () => Promise<void> {
  return () => runInDurableObject(
    env.DATA_LAYER_GATEKEEPER.getByName(crypto.randomUUID()),
    async (gatekeeper: DataLayerGatekeeper) => {
      const queue = recordingQueue();
      const session = await gatekeeper.startSession(queue as never);
      await fn(session, queue);
    });
}

const ENG = "schema/f01_engineering";

describe.skipIf(!live)("live", () => {
  it("lists f01_engineering, and reports it", withSession(async (session, queue) => {
    const schemas = await session.listSchemas();
    expect(schemas.map(s => s.name)).toContain("f01_engineering");
    expect(schemas.every(s => /^f\d{2}_/.test(s.name))).toBe(true);
    expect(queue.observations.at(-1)?.subresources).toEqual(schemas.map(s => `schema/${s.name}`));
  }));

  it("lists tables and views with kinds and row estimates", withSession(async (session, queue) => {
    const tables = await session.listTables("f01_engineering");
    const byName = new Map(tables.map(t => [t.name, t]));
    expect(byName.get("jira_issues")?.kind).toBe("table");
    expect(byName.get("jira_issue_lifecycle")?.kind).toBe("view");
    expect(byName.get("jira_issue_current_status")?.kind).toBe("view");
    expect(byName.get("jira_issue_lifecycle")?.approximateRowCount).toBeNull();
    expect(typeof byName.get("jira_issues")?.approximateRowCount).toBe("number");
    expect(queue.observations.at(-1)?.subresources).toEqual([ENG]);
  }));

  it("describes a table with types, comments and its primary key", withSession(async (session) => {
    const t = await session.describeTable("f01_engineering", "jira_issues");
    expect(t.primaryKey).toEqual(["issue_id"]);
    const cols = new Map(t.columns.map(c => [c.name, c]));
    expect(cols.get("issue_id")?.dataType).toBe("int8");
    expect(cols.get("created_at")?.dataType).toBe("timestamptz");
    expect(cols.get("labels")?.dataType).toBe("text[]");
    expect(cols.get("issue_id")?.nullable).toBe(false);
  }));

  it("refuses schemas it may not read", withSession(async (session, queue) => {
    await expect(session.listTables("ingest")).rejects.toThrow(/not readable/);
    await expect(session.describeTable("net", "http_request_queue")).rejects.toThrow(/not readable/);
    expect(queue.observations).toHaveLength(0);
  }));

  it("maps values as types.d.ts promises", withSession(async (session, queue) => {
    const r = await session.query(`select
      9007199254740993::int8 as big, 1.50::numeric as num, 7::int4 as small, 1.5::float8 as f,
      '2026-11-19 18:00:05.123456+05:30'::timestamptz as tz, '2026-11-19 18:00:05'::timestamp as ts,
      '2026-11-19'::date as d, '13 days 04:02:11'::interval as iv, '{"a":[1,2]}'::jsonb as j,
      array['x','y'] as arr, array['2026-11-19 00:00:00+00'::timestamptz] as tzs, null::text as n,
      'infinity'::timestamptz as inf`);
    const row = r.rows[0]!;
    expect(row).toEqual({
      big: "9007199254740993", num: "1.50", small: 7, f: 1.5,
      tz: "2026-11-19T12:30:05.123Z", ts: "2026-11-19T18:00:05.000", d: "2026-11-19",
      iv: "13 days 04:02:11", j: { a: [1, 2] }, arr: ["x", "y"], tzs: ["2026-11-19T00:00:00.000Z"],
      n: null, inf: "infinity",
    });
    expect(r.columns[0]).toBe("big");
    expect(queue.observations.at(-1)?.subresources).toEqual([]);
  }));

  it("answers a golden question fast through the current-status view", withSession(async (session, queue) => {
    const started = Date.now();
    const r = await session.query(`select u.issue_key,
        floor(extract(epoch from u.duration) / 86400)::int as days_in_uat, l.is_stale
      from f01_engineering.jira_issue_current_status u
      join f01_engineering.jira_issue_lifecycle l on l.issue_id = u.issue_id
      where u.status = 'UAT' and l.issue_type = 'Bug' and 'AP' = any(l.product_areas)`);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.columns).toEqual(["issue_key", "days_in_uat", "is_stale"]);
    expect(r.truncated).toBe(false);
    const obs = queue.observations.at(-1)!;
    expect(obs.subresources).toEqual([ENG]);
    expect(obs.title).toBe("Query company data");
  }));

  it("reads data_freshness, whose view reads ingest", withSession(async (session, queue) => {
    const r = await session.query("select source, last_successful_sync_at from f01_engineering.data_freshness");
    expect(r.rowCount).toBeGreaterThan(0);
    expect(String(r.rows[0]!.last_successful_sync_at)).toMatch(/Z$/);
    expect(queue.observations.at(-1)?.subresources).toEqual([ENG]);
  }));

  it("caps rows at 500 and says so", withSession(async (session) => {
    const r = await session.query("select issue_id from f01_engineering.jira_issues");
    expect(r.rowCount).toBe(500);
    expect(r.truncated).toBe(true);
  }));

  it("binds parameters", withSession(async (session) => {
    const r = await session.query(
      "select count(*)::int as n from f01_engineering.jira_issues where issue_key = any($1::text[])",
      [["SPEND-1", "SPEND-2"]]);
    expect(typeof r.rows[0]!.n).toBe("number");
  }));

  it("refuses a second statement, with or without parameters", withSession(async (session, queue) => {
    await expect(session.query("select 1; select 2")).rejects.toThrow(/^Rejected:/);
    // A statement break the text pass can't see as one would still be a second statement to
    // Postgres; the extended protocol refuses it.
    await expect(session.query("select 1) as a; commit; select (1")).rejects.toThrow(/^Rejected:/);
    expect(queue.observations).toHaveLength(0);
  }));

  it("lets Postgres refuse what the login can't read", withSession(async (session) => {
    await expect(session.query("select count(*) from f01_engineering.jira_issues i, \"ingest\".\"jira_issue_raw\" r"))
      .rejects.toThrow(/^Rejected:/);
    await expect(session.query("select * from pg_catalog.pg_settings")).rejects.toThrow(/^Rejected:/);
  }));

  it("refuses a plan-time leak through a stable function before Postgres plans it", withSession(async (session) => {
    await expect(session.query(
      "select 1 from f01_engineering.jira_issues where summary = (table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '')::text::int)::text",
    )).rejects.toThrow(/^Rejected: `table_to_xml`/);
  }));
});

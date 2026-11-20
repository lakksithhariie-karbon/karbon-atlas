// Attacks against Data Layer.query() and the other three methods. A probe that returns rows, or an
// error that quotes net/ingest/vault/auth data, fails the test. Rejected: must record no observation.
// Writes are `where false` or are rolled back with the read-only transaction. net.http_* targets
// 127.0.0.1:9 only. Counts and SQLSTATEs only — never row contents.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { connect, runQuery, type PreparedQuery } from "../src/database.js";
import type { DataLayer, DataLayerValue } from "../src/types.js";
import type { DataLayerGatekeeper } from "../src/worker.js";

const live = Boolean(env.DATA_LAYER_DATABASE_URL);

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

/** SQLSTATEs that mean Postgres refused the statement. A timeout is not one of them: the call ran. */
const PG_BLOCK = new Set([
  "42501", "25006", "42601", "42P01", "42883", "42804", "42809", "42704", "42703", "42P02",
  "3F000", "22023", "42622", "42725", "42846", "0A000", "0LP01", "42501",
]);

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").slice(0, 180);
}

function assertSafeError(error: unknown, queue: Queue, before: number, sql: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  if (message.length > 800) {
    throw new Error(`LEAK: error is ${message.length} chars (code=${code ?? "none"}) sql=${oneLine(sql)}`);
  }
  for (const marker of ["ingest.", "vault.", "auth.", "net."]) {
    if (message.includes(marker) && !sql.includes(marker)) {
      throw new Error(`LEAK: error mentions ${marker} which the SQL does not (len=${message.length}) sql=${oneLine(sql)}`);
    }
  }
  const rejected = message.startsWith("Rejected:");
  if (!rejected && !(code && PG_BLOCK.has(code))) {
    throw new Error(`not blocked (code=${code ?? "none"}): ${message.slice(0, 200)} sql=${oneLine(sql)}`);
  }
  if (queue.observations.length !== before) {
    throw new Error(
      `${rejected ? "Rejected" : code} recorded ${queue.observations.length - before} observation(s): ${message.slice(0, 160)}`,
    );
  }
}

/** The probe must not come back as rows. Sensitive SQL (net, ingest, vault, auth) omits rowCount. */
async function expectBlocked(session: DataLayer, queue: Queue, sql: string, params?: DataLayerValue[]): Promise<void> {
  const before = queue.observations.length;
  try {
    const result = await session.query(sql, params);
    const sensitive = /\b(net|ingest|vault|auth)\b/i.test(sql);
    const detail = sensitive ? "rows withheld" : `rowCount=${result.rowCount} truncated=${result.truncated}`;
    throw new Error(`ATTACK SUCCEEDED (${detail}) sql=${oneLine(sql)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ATTACK SUCCEEDED")) throw error;
    assertSafeError(error, queue, before, sql);
  }
}

const NET_REG = "'net.http_request_queue'::regclass";

// Assert inside the durable object. A PostgresError's code does not survive the RPC boundary.
function expectSqlstate(prepared: PreparedQuery, codes: string[]): () => Promise<void> {
  return () => runInDurableObject(
    env.DATA_LAYER_GATEKEEPER.getByName(crypto.randomUUID()),
    async () => {
      const url = env.DATA_LAYER_DATABASE_URL;
      if (!url) throw new Error("no database url");
      const sql = connect(url);
      try {
        let result: { rowCount?: number } | undefined;
        try {
          result = await runQuery(sql, prepared);
        } catch (error) {
          const code = (error as { code?: string }).code;
          const message = error instanceof Error ? error.message : String(error);
          if (message.length > 400) {
            throw new Error(`LEAK: error is ${message.length} chars (code=${code ?? "none"})`, { cause: error });
          }
          expect(codes, message.slice(0, 200)).toContain(code);
          return;
        }
        throw new Error(`ATTACK SUCCEEDED (rowCount=${result?.rowCount ?? "none"}) sql=${oneLine(prepared.wrapped)}`);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    });
}

describe.skipIf(!live)("attacks", () => {
  describe("reaching denied schemas and catalogs", () => {
    const probes: [string, string][] = [
      ["net queue", "select count(*)::int as n from net.http_request_queue"],
      ["net response", "select count(*)::int as n from net._http_response"],
      ["quoted net", `select count(*)::int as n from "net"."http_request_queue"`],
      ["mixed-case net", "select count(*)::int as n from NeT.Http_Request_Queue"],
      ["quoted mixed-case net", `select count(*)::int as n from "NeT"."HTTP_Request_Queue"`],
      ["comment-split name", "select count(*)::int as n from ne/**/t.http_request_queue"],
      ["nested comment split", "select count(*)::int as n from ne/*/**/*/t._http_response"],
      ["alias of the queue", "select count(*)::int as n from net.http_request_queue q"],
      ["alias spelled net on an allowed table", "select count(*)::int as n from f01_engineering.jira_issues net where false"],
      ["ingest", "select count(*)::int as n from ingest.jira_sync_runs"],
      ["vault", "select count(*)::int as n from vault.decrypted_secrets"],
      ["auth", "select count(*)::int as n from auth.users"],
      ["information_schema", "select count(*)::int as n from information_schema.tables"],
      ["quoted information_schema", `select count(*)::int as n from "information_schema"."tables"`],
      ["pg_class", "select count(*)::int as n from pg_catalog.pg_class"],
      ["pg_settings", "select count(*)::int as n from pg_catalog.pg_settings"],
      ["pg_stat_activity", "select count(*)::int as n from pg_catalog.pg_stat_activity"],
      ["pg_stats", "select count(*)::int as n from pg_catalog.pg_stats"],
      ["pg_roles", "select count(*)::int as n from pg_catalog.pg_roles"],
      ["unqualified pg_roles", "select count(*)::int as n from pg_roles"],
      ["pg_user", "select count(*)::int as n from pg_user"],
      ["pg_authid", "select count(*)::int as n from pg_authid"],
      ["pg_shadow", "select count(*)::int as n from pg_shadow"],
      ["pg_prepared_statements", "select count(*)::int as n from pg_prepared_statements"],
      ["pg_db_role_setting", "select count(*)::int as n from pg_db_role_setting"],
      ["pg_auth_members", "select count(*)::int as n from pg_auth_members"],
      ["cron.job", "select count(*)::int as n from cron.job"],
      ["pg_stat_statements", "select count(*)::int as n from extensions.pg_stat_statements"],
      ["table statement on pg_roles", "table pg_catalog.pg_roles"],
      ["unicode escape identifier", `select count(*)::int as n from U&"net".U&"http_request_queue"`],
    ];
    for (const [name, sql] of probes) {
      it(name, withSession(async (session, queue) => {
        await expectBlocked(session, queue, sql);
      }));
    }

    it("a denied name inside a string is the string, not a read", withSession(async (session, queue) => {
      const literal = "net.http_request_queue";
      const r = await session.query("select $$net.http_request_queue$$ as lit");
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.lit).toBe(literal);
      expect(queue.observations.at(-1)?.subresources).toEqual([]);
      const e = await session.query("select E'net\\\\http_request_queue' as lit");
      expect(e.rows[0]!.lit).toBe("net\\http_request_queue");
    }));

    it("dollar-quoted semicolon is not a second statement", withSession(async (session, queue) => {
      const r = await session.query("select $$; select 2$$ as lit");
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.lit).toBe("; select 2");
      expect(queue.observations).toHaveLength(1);
    }));

    it("nested block comments do not glue a denied name", withSession(async (session, queue) => {
      const r = await session.query("select 1 /* /* */ */ as n");
      expect(r.rows[0]!.n).toBe(1);
      expect(queue.observations.at(-1)?.subresources).toEqual([]);
    }));

    it("a bound parameter is not SQL", withSession(async (session, queue) => {
      const payload = "'; select count(*) from net.http_request_queue; --";
      const r = await session.query(
        "select $1::text as lit from f01_engineering.jira_issues where false",
        [payload],
      );
      expect(r.rowCount).toBe(0);
      expect(queue.observations.at(-1)?.subresources).toEqual([ENG]);
      const one = await session.query("select $1::text as lit", [payload]);
      expect(one.rows[0]!.lit).toBe(payload);
    }));
  });

  describe("plan-time evaluation", () => {
    const places: [string, string][] = [
      ["where", `select 1 from f01_engineering.jira_issues where summary = (table_to_xml(${"'f01_engineering.jira_projects'::regclass"}, true, false, '')::text::int)::text`],
      ["join on", `select 1 from (values (1)) v(n) join (values (1)) w(m) on table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '')::text = ''`],
      ["order by", "select 1 order by table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '')::text"],
      ["limit", "select 1 from (values (1)) v(n) limit (table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '')::text::int)"],
      ["values", "values (table_to_xml('f01_engineering.jira_projects'::regclass, true, false, ''))"],
      ["case", "select case when true then table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '') end"],
      ["quoted name", `select "table_to_xml"('f01_engineering.jira_projects'::regclass, true, false, '')`],
      ["schema-qualified", "select pg_catalog.table_to_xml('f01_engineering.jira_projects'::regclass, true, false, '')"],
      ["query_to_xml", "select query_to_xml($$select 1$$, true, false, '')"],
      ["schema_to_xml of vault", "select schema_to_xml('vault', true, false, '')::text::int"],
      ["database_to_xml", "select database_to_xml(false, false, '')::text::int"],
      ["cursor_to_xml", "select cursor_to_xml('c'::refcursor, 1, true, false, '')"],
    ];
    for (const [name, sql] of places) {
      it(`table dump function in ${name}`, withSession(async (session, queue) => {
        await expectBlocked(session, queue, sql);
      }));
    }

    const stable: [string, string][] = [
      ["to_regclass of the net queue", `select to_regclass(${NET_REG}) as n`],
      ["to_regclass in where", `select 1 where to_regclass(${NET_REG}) is null`],
      ["live tuples of the net queue", `select pg_stat_get_live_tuples(${NET_REG}) as n`],
      ["live tuples in where", `select 1 where pg_stat_get_live_tuples(${NET_REG}) >= 0`],
      ["live tuples in order by", `select 1 order by pg_stat_get_live_tuples(${NET_REG})`],
      ["live tuples in limit", `select 1 from (values (1)) v(n) limit pg_stat_get_live_tuples(${NET_REG})::int`],
      ["live tuples in values", `values (pg_stat_get_live_tuples(${NET_REG}))`],
      ["live tuples in case", `select case when true then pg_stat_get_live_tuples(${NET_REG}) end as n`],
      ["live tuples in join on", `select 1 from (values (1)) v(n) join (values (1)) w(m) on pg_stat_get_live_tuples(${NET_REG}) >= 0`],
      ["relation filepath of the net queue", `select pg_relation_filepath(${NET_REG}) as n`],
      ["view definition via cast error", "select (pg_get_viewdef('f01_engineering.data_freshness'::regclass))::int as n"],
      ["view definition returned", "select pg_get_viewdef('f01_engineering.data_freshness'::regclass) as n"],
      ["inet_server_addr", "select inet_server_addr() as n"],
      ["inet_server_port", "select inet_server_port() as n"],
      ["pg_show_all_file_settings", "select count(*)::int as n from pg_show_all_file_settings()"],
    ];
    for (const [name, sql] of stable) {
      it(name, withSession(async (session, queue) => {
        await expectBlocked(session, queue, sql);
      }));
    }
  });

  describe("escaping the wrapper", () => {
    const probes: [string, string][] = [
      ["unbalanced parenthesis", "select 1)"],
      ["second statement", "select 1; select 2"],
      ["second statement with a parameter", "select 1; select $1"],
      ["semicolon hidden after a comment's semicolon", "select 1)\nunion all\nselect 2; /* ; */"],
      ["for update", "select issue_id from f01_engineering.jira_issues for update"],
      ["for share", "select issue_id from f01_engineering.jira_issues for share"],
      ["for key share", "select issue_id from f01_engineering.jira_issues for key share"],
      ["data-modifying cte", "with d as (insert into net.http_request_queue (method, url) select 'GET', 'http://127.0.0.1:9/' where false returning 1) select * from d"],
      ["select into", "select 1 into temp t_attack"],
      ["paren reused to close the wrapper", "select 1 as n) union all select 2 from (select 1 as x"],
      ["union after an early close and a line comment", "select 1 as n) union all select 2 --"],
    ];
    for (const [name, sql] of probes) {
      it(name, withSession(async (session, queue) => {
        const params = name.includes("parameter") ? [2] : undefined;
        await expectBlocked(session, queue, sql, params);
      }));
    }

    it("a trailing line comment does not swallow the wrapper", withSession(async (session, queue) => {
      const r = await session.query("select 1 as n --");
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.n).toBe(1);
      expect(r.truncated).toBe(false);
      expect(queue.observations.at(-1)?.subresources).toEqual([]);
    }));

    it("does not return more than 500 rows", withSession(async (session) => {
      const r = await session.query("select g::int as g from generate_series(1, 800) g");
      expect(r.rowCount).toBe(500);
      expect(r.truncated).toBe(true);
    }));

    it("a trailing comment on a long series still caps at 500", withSession(async (session) => {
      const r = await session.query("select g::int as g from generate_series(1, 800) g --");
      expect(r.rowCount).toBeLessThanOrEqual(500);
      expect(r.truncated).toBe(true);
    }));
  });

  describe("side effects", () => {
    const probes: [string, string][] = [
      ["set_config", "select set_config('statement_timeout', '0', false)"],
      ["set_config of search_path", "select set_config('search_path', 'net, pg_catalog', true)"],
      ["current_setting", "select current_setting('data_directory')"],
      ["pg_sleep", "select pg_sleep(1)"],
      ["pg_sleep_for", "select pg_sleep_for('1 second')"],
      ["pg_sleep_until", "select pg_sleep_until(now())"],
      ["advisory lock", "select pg_advisory_lock(8675309)"],
      ["xact advisory lock", "select pg_try_advisory_xact_lock_shared(8675309)"],
      ["nextval of a missing sequence", "select nextval('f01_engineering.no_such_attack_seq')"],
      ["setval of a missing sequence", "select setval('f01_engineering.no_such_attack_seq', 1)"],
      ["dblink", "select dblink_connect('host=127.0.0.1 port=1 dbname=x user=x')"],
      ["lo_import of a missing file", "select lo_import('/no/such/attack-file')"],
      ["pg_read_file of a missing file", "select pg_read_file('/no/such/attack-file', 0, 0)"],
      ["pg_ls_dir", "select pg_ls_dir('/no/such')"],
      ["pg_notify", "select pg_notify('karbon_attack', 'x')"],
      ["pg_cancel_backend", "select pg_cancel_backend(-1)"],
      ["pg_terminate_backend", "select pg_terminate_backend(0)"],
      ["net.http_get to a closed port", "select net.http_get('http://127.0.0.1:9/')"],
      ["http_get unqualified", "select http_get('http://127.0.0.1:9/')"],
      ["http_collect_response", "select net.http_collect_response(0, true)"],
      ["_await_response", "select net._await_response(0)"],
      ["worker_restart", "select net.worker_restart()"],
      ["cron.schedule with no arguments", "select cron.schedule()"],
      ["auth.uid", "select auth.uid()"],
    ];
    for (const [name, sql] of probes) {
      it(name, withSession(async (session, queue) => {
        await expectBlocked(session, queue, sql);
      }));
    }
  });

  describe("result shaping", () => {
    it("rejects duplicate column names with no observation", withSession(async (session, queue) => {
      await expectBlocked(session, queue, "select 1 as a, 2 as a");
    }));

    it("rejects a __proto__ column and does not pollute Object.prototype", withSession(async (session, queue) => {
      await expectBlocked(session, queue, `select 1 as "__proto__"`);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    }));

    it("a jsonb __proto__ key does not pollute Object.prototype", withSession(async (session) => {
      const r = await session.query(`select '{"__proto__":{"polluted":true}}'::jsonb as j`);
      expect(r.rowCount).toBe(1);
      const cell = r.rows[0]!.j;
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
      if (cell !== null && typeof cell === "object") {
        const own = Object.hasOwn(cell, "polluted");
        const viaProto = (cell as { polluted?: boolean }).polluted === true && !own;
        expect(viaProto).toBe(false);
      }
    }));

    it("rejects bytea and bytea[]", withSession(async (session, queue) => {
      await expectBlocked(session, queue, "select '\\x01'::bytea as b");
      await expectBlocked(session, queue, "select array['\\x01'::bytea] as b");
    }));

    it("returns a result near 5 MB", withSession(async (session, queue) => {
      const n = 4_000_000;
      const r = await session.query(`select repeat('a', ${n}) as c`);
      expect(r.rowCount).toBe(1);
      expect(String(r.rows[0]!.c).length).toBe(n);
      expect(queue.observations.at(-1)?.subresources).toEqual([]);
    }));

    // The size is only known once the rows arrive, so this one is recorded first (README, "Query
    // path"): the caller still receives nothing.
    it("rejects a result above 5 MB, after recording the query", withSession(async (session, queue) => {
      await expect(session.query("select repeat('a', 5300000) as c")).rejects.toThrow(/^Rejected: .*5 MB/);
      expect(queue.observations).toHaveLength(1);
    }));

    it("keeps NaN and infinities as numbers", withSession(async (session) => {
      const r = await session.query("select 'NaN'::float8 as n, 'Infinity'::float8 as p, '-Infinity'::float8 as m");
      const row = r.rows[0]!;
      expect(typeof row.n).toBe("number");
      expect(Number.isNaN(row.n)).toBe(true);
      expect(row.p).toBe(Number.POSITIVE_INFINITY);
      expect(row.m).toBe(Number.NEGATIVE_INFINITY);
    }));

    it("keeps BC and year-10000 timestamps as Postgres text", withSession(async (session) => {
      const r = await session.query(
        "select '4714-11-24 00:00:00 BC'::timestamp as bc, '10000-01-01 00:00:00'::timestamp as y, '-infinity'::timestamptz as ninf",
      );
      const row = r.rows[0]!;
      expect(typeof row.bc).toBe("string");
      expect(String(row.bc)).toMatch(/BC$/);
      expect(String(row.y).startsWith("10000-")).toBe(true);
      expect(String(row.ninf)).toMatch(/infinity/i);
    }));
  });

  describe("observations", () => {
    it("reports f01 for a where false scan the planner can remove", withSession(async (session, queue) => {
      const r = await session.query("select count(*)::int as n from f01_engineering.jira_issues where false");
      expect(typeof r.rows[0]!.n).toBe("number");
      expect(queue.observations).toHaveLength(1);
      expect(queue.observations[0]!.subresources).toEqual([ENG]);
    }));

    it("reports f01 for a join the planner can eliminate", withSession(async (session, queue) => {
      const r = await session.query(`select count(*)::int as n
        from f01_engineering.jira_issues i
        left join f01_engineering.jira_projects p on false
        where false`);
      expect(typeof r.rows[0]!.n).toBe("number");
      expect(queue.observations[0]!.subresources).toEqual([ENG]);
    }));

    it("reports f01 for data_freshness and not ingest", withSession(async (session, queue) => {
      const r = await session.query("select count(*)::int as n from f01_engineering.data_freshness");
      expect(r.rowCount).toBe(1);
      expect(queue.observations[0]!.subresources).toEqual([ENG]);
    }));

    it("reports nothing for select 1", withSession(async (session, queue) => {
      await session.query("select 1 as n");
      expect(queue.observations[0]!.subresources).toEqual([]);
    }));

    it("reports nothing for values", withSession(async (session, queue) => {
      await session.query("values (1)");
      expect(queue.observations[0]!.subresources).toEqual([]);
    }));
  });

  describe("listTables and describeTable", () => {
    const schemas = [
      "ingest", "net", "pg_catalog", "information_schema", "vault", "auth", "public", "cron",
      "extensions", "NET", `"net"`, "f01_engineering' or '1'='1",
      "a".repeat(64), "a".repeat(80), `f01_${"a".repeat(70)}`, "f01_engineering\u0000net",
    ];
    for (const schema of schemas) {
      it(`listTables refuses ${JSON.stringify(schema).slice(0, 40)}`, withSession(async (session, queue) => {
        await expect(session.listTables(schema)).rejects.toThrow(/not readable|Rejected:/);
        expect(queue.observations).toHaveLength(0);
      }));
    }

    it("listTables of f01 lists only that schema", withSession(async (session, queue) => {
      const tables = await session.listTables("f01_engineering");
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every(t => t.schema === "f01_engineering")).toBe(true);
      const names = new Set(tables.map(t => t.name));
      expect(names.has("http_request_queue")).toBe(false);
      expect(names.has("_http_response")).toBe(false);
      expect(names.has("jira_issues")).toBe(true);
      expect(queue.observations[0]!.subresources).toEqual([ENG]);
    }));

    it("listSchemas lists only function schemas", withSession(async (session) => {
      const listed = await session.listSchemas();
      expect(listed.every(s => /^f\d{2}_[a-z0-9_]+$/.test(s.name))).toBe(true);
      expect(listed.map(s => s.name)).not.toEqual(expect.arrayContaining(["net", "ingest", "vault", "auth", "pg_catalog"]));
    }));

    const describes: [string, string, string][] = [
      ["ingest", "jira_sync_runs", "ingest.jira_sync_runs"],
      ["net", "http_request_queue", "net.http_request_queue"],
      ["pg_catalog", "pg_class", "pg_catalog.pg_class"],
      ["vault", "decrypted_secrets", "vault.decrypted_secrets"],
      ["f01_engineering", `"jira_issues"`, "quoted jira_issues"],
      ["f01_engineering", "a".repeat(64), "64-byte name"],
      ["f01_engineering", "a".repeat(80), "80-byte name"],
      ["f01_engineering", "jira_issues\u0000hidden", "null byte in the name"],
      ["f01_engineering", "jira_issues'; drop table jira_issues; --", "injected name"],
    ];
    for (const [schema, name, label] of describes) {
      it(`describeTable refuses ${label}`, withSession(async (session, queue) => {
        const message = await session.describeTable(schema, name).then(
          () => { throw new Error(`ATTACK SUCCEEDED describe ${label}`); },
          (error: Error) => error.message,
        );
        expect(message.length).toBeLessThan(500);
        expect(message).not.toMatch(/ingest\.|password authentication|supabase\.co/i);
        expect(queue.observations).toHaveLength(0);
      }));
    }

    it("describeTable of jira_issues stays in f01", withSession(async (session, queue) => {
      const t = await session.describeTable("f01_engineering", "jira_issues");
      expect(t.schema).toBe("f01_engineering");
      expect(t.name).toBe("jira_issues");
      expect(queue.observations[0]!.subresources).toEqual([ENG]);
    }));
  });

  describe("extended protocol alone", () => {

    it("rejects select 1; select 2 with 42601", expectSqlstate(
      { wrapped: "select 1; select 2", params: [], schemas: [] },
      ["42601"],
    ));

    it("rejects a commit hidden after a semicolon with 42601", expectSqlstate(
      { wrapped: "select 1; commit", params: [], schemas: [] },
      ["42601"],
    ));

    it("rejects commit and a following select with 42601", expectSqlstate(
      { wrapped: "select 1;commit;select 1", params: [], schemas: [] },
      ["42601"],
    ));

    it("a where-false insert into the net queue is refused by the read-only transaction", expectSqlstate({
      wrapped: "insert into net.http_request_queue (method, url) select 'GET', 'http://127.0.0.1:9/' where false",
      params: [],
      schemas: [],
    }, ["25006", "42501"]));
  });
});

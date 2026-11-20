import { describe, expect, it } from "vitest";
import { checkColumnNames, checkPlan, checkText, tokenize, wrapQuery } from "../src/guard.js";

const ENG = ["f01_engineering"];
const ok = (sql: string) => checkText(sql, ENG, ["net", "storage"]);
const refused = (sql: string) => expect(() => ok(sql)).toThrow(/^Rejected: /);
const words = (sql: string) =>
  tokenize(sql).flatMap(t => t.kind === "word" || t.kind === "quoted" ? [t.value] : []);

describe("tokenize", () => {
  it("drops comments, nested ones included, and never looks inside strings", () => {
    expect(words("select /* a /* b */ net */ 1 -- net\n from x")).toEqual(["select", "from", "x"]);
    expect(words("select 'net.http_get(''x'')', $$ net $$, $t$ $$ net $t$, E'\\' net'")).toEqual(["select"]);
    expect(words('select "Net"."x""y"')).toEqual(["select", "Net", 'x"y']);
    expect(words("select ne/**/t")).toEqual(["select", "ne", "t"]);
  });

  it("reads parameters, numbers and dollar quotes apart", () => {
    const kinds = tokenize("select $1, 1.5e-3, $a$x$a$").map(t => t.kind);
    expect(kinds).toEqual(["word", "param", "punct", "number", "punct", "string"]);
  });

  it("refuses what it can't read safely", () => {
    for (const sql of ["select 'x", "select \"x", "select /* x", "select $q$ x", "select U&\"\\0061\"", "select u&'x'"]) {
      expect(() => tokenize(sql), sql).toThrow(/^Rejected: /);
    }
  });
});

describe("checkText", () => {
  it("accepts one read, with one trailing semicolon, and finds the schemas it names", () => {
    expect(ok("select * from f01_engineering.jira_issues;")).toEqual({
      body: "select * from f01_engineering.jira_issues", schemasNamed: ["f01_engineering"],
    });
    expect(ok("with x as (select 1) select * from x").schemasNamed).toEqual([]);
    expect(ok('values (1)').body).toBe("values (1)");
    expect(ok('table "f01_engineering".jira_issues').schemasNamed).toEqual(["f01_engineering"]);
    expect(ok("(select 1)").body).toBe("(select 1)");
    // A semicolon inside a string or comment is not a statement break.
    expect(ok("select ';' -- ;\n").body).toBe("select ';' -- ;\n");
  });

  it("refuses more than one statement, and anything but a read", () => {
    refused("select 1; select 2");
    refused("select 1;;");
    refused("");
    refused("-- only a comment");
    refused("show search_path");
    refused("explain select 1");
    refused("with d as (delete from f01_engineering.jira_issues returning *) select * from d");
    refused("select * into t from f01_engineering.jira_issues");
    refused("select * from f01_engineering.jira_issues for update");
    refused("select * from f01_engineering.jira_issues for share");
  });

  it("refuses denied functions however they are spelled", () => {
    refused("select table_to_xml('x'::regclass, true, false, '')");
    refused('select "QUERY_TO_XML"(\'select 1\', true, false, \'\')');
    refused("select pg_catalog.set_config('statement_timeout', '0', true)");
    refused("select current_setting('server_version')");
    refused("select pg_sleep(1)");
    refused("select pg_advisory_lock(1)");
    refused("select ts_stat('select 1')");
    refused("select lo_import('/etc/hostname')");
    refused("select pg_read_file('/etc/hostname')");
    refused("select dblink('x', 'y')");
    refused("select nextval('s')");
  });

  it("refuses schemas outside the allowed ones, by name", () => {
    refused("select * from net.http_request_queue");
    refused('select * from "net"."_http_response"');
    refused('select * from "NET".x');
    refused("select * from storage.objects");
    refused("select * from ingest.jira_issue_raw");
    refused("select * from information_schema.tables");
    refused("select 1 from f01_engineering.jira_issues as vault");
  });

  it("refuses parentheses that would reach outside the wrapper", () => {
    refused("select 1 as n) union all select 2 from (select 1 as x");
    refused("select (1");
    refused("select 1)");
    expect(() => ok("select (1) union all (select 2)")).not.toThrow();
    expect(() => ok("select ')' as p, '(' as q")).not.toThrow();
  });

  it("strips the trailing semicolon at the token, not at the last ';' in the text", () => {
    expect(ok("select 1; /* ; */").body).toBe("select 1");
  });

  it("refuses pg_* functions and catalog text, but not the pg_catalog qualifier", () => {
    refused("select pg_get_viewdef('f01_engineering.data_freshness'::regclass)");
    refused("select pg_stat_get_live_tuples('x'::regclass)");
    refused("select pg_relation_filepath('x'::regclass)");
    refused("select * from pg_prepared_statements");
    refused("select inet_server_addr()");
    refused("select col_description(1, 1)");
    expect(() => ok("select pg_catalog.upper('x'), pg_typeof(1)")).not.toThrow();
  });

  it("does not mistake strings, comments or ordinary columns for denied names", () => {
    expect(() => ok("select 'net.http_get' as s, summary from f01_engineering.jira_issues /* vault */")).not.toThrow();
    expect(() => ok('select "update" from f01_engineering.jira_issues')).not.toThrow();
    expect(() => ok("select lo_priority, http_status from f01_engineering.jira_issues")).not.toThrow();
  });
});

describe("wrapQuery", () => {
  it("caps rows one past the limit, and keeps a trailing comment inside", () => {
    expect(wrapQuery("select 1 -- note", 500)).toBe("SELECT * FROM (\nselect 1 -- note\n) AS q LIMIT 501");
  });
});

/** A one-node plan as EXPLAIN (VERBOSE, FORMAT JSON) returns it. */
const plan = (node: Record<string, unknown>) => [{ Plan: node }];

const scan = (name: string) => plan({ "Node Type": "Function Scan", "Function Name": name, Schema: "pg_catalog" });

describe("checkPlan", () => {
  it("returns every relation scanned, nested plans included", () => {
    const explain = plan({
      "Node Type": "Hash Join", Output: ["i.issue_key"], "Hash Cond": "(i.issue_id = s.issue_id)",
      Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "jira_issues", Schema: "f01_engineering", Alias: "i", Output: ["i.issue_key"] },
        { "Node Type": "Seq Scan", "Relation Name": "jira_sync_runs", Schema: "ingest", Alias: "r", Filter: "(r.mode = 'full'::text)" },
      ],
    });
    expect(checkPlan(explain).relations).toEqual([
      { schema: "f01_engineering", name: "jira_issues" }, { schema: "ingest", name: "jira_sync_runs" },
    ]);
  });

  it("refuses row locks and writes", () => {
    expect(() => checkPlan(plan({ "Node Type": "LockRows" }))).toThrow(/^Rejected: .*row locks/);
    expect(() => checkPlan(plan({ "Node Type": "ModifyTable" }))).toThrow(/^Rejected: /);
  });

  it("refuses function scans and calls outside pg_catalog, and denied functions anywhere", () => {
    expect(() => checkPlan(plan({ "Node Type": "Function Scan", "Function Name": "http_get", Schema: "net" })))
      .toThrow(/^Rejected: /);
    expect(() => checkPlan(plan({ "Node Type": "Function Scan", "Function Name": "pg_show_all_settings", Schema: "pg_catalog" })))
      .toThrow(/^Rejected: /);
    expect(() => checkPlan(plan({ "Node Type": "Result", Output: ["extensions.digest('a'::text, 'sha256'::text)"] })))
      .toThrow(/^Rejected: function `extensions.digest`/);
    expect(() => checkPlan(plan({ "Node Type": "Result", Output: ["(1 OPERATOR(extensions.+) 2)"] })))
      .toThrow(/^Rejected: operators/);
    expect(() => checkPlan(plan({ "Node Type": "Result", "One-Time Filter": "(query_to_xml('x'::text, true, false, ''::text) IS NOT NULL)" })))
      .toThrow(/^Rejected: /);
  });

  it("reads only from allowlisted set-returning functions", () => {
    expect(() => checkPlan(scan("generate_series"))).not.toThrow();
    expect(() => checkPlan(scan("unnest"))).not.toThrow();
    expect(() => checkPlan(scan("pg_prepared_statement"))).toThrow(/^Rejected: /);
    expect(() => checkPlan(scan("pg_lock_status"))).toThrow(/^Rejected: /);
  });

  it("accepts ordinary expressions, pg_catalog qualifiers and names in name fields", () => {
    expect(() => checkPlan(plan({
      "Node Type": "Seq Scan", "Relation Name": "x", Schema: "f01_engineering", Alias: "query_to_xml(",
      Output: ["upper(x.summary)", "pg_catalog.lower(x.summary)", "EXTRACT(epoch FROM x.d)", "(x.a OPERATOR(pg_catalog.+) 1)"],
      "Subplan Name": "InitPlan 1 (returns $0)",
    }))).not.toThrow();
  });
});

describe("checkColumnNames", () => {
  it("refuses duplicates and __proto__", () => {
    expect(() => checkColumnNames(["a", "b"])).not.toThrow();
    expect(() => checkColumnNames(["issue_id", "issue_id"])).toThrow(/^Rejected: .*two columns named `issue_id`/);
    expect(() => checkColumnNames(["__proto__"])).toThrow(/^Rejected: /);
  });
});

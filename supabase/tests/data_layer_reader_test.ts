/**
 * Least-privilege checks for the karbon_data_reader login.
 *
 * The URL is read from the repo root `.dev.vars` and is never printed.
 * Write probes either match no rows or run in a transaction that is always
 * rolled back. `net.http_get` is only aimed at 127.0.0.1:9 and is rolled back.
 */
import postgres from "npm:postgres@3.4.5";

const PERMISSION_DENIED = "42501";
const READ_ONLY_TRANSACTION = "25006";
const QUERY_CANCELED = "57014";
const PROBE_URL = "http://127.0.0.1:9/";

const DENIED_RELATIONS = [
  ["vault", "secrets"],
  ["vault", "decrypted_secrets"],
  ["auth", "users"],
  ["cron", "job"],
  ["cron", "job_run_details"],
  ["storage", "objects"],
  ["pg_catalog", "pg_authid"],
  ["pg_catalog", "pg_shadow"],
] as const;

const DENIED_SCHEMAS = ["ingest", "vault", "auth", "cron", "storage"] as const;

type Row = Record<string, unknown>;

interface Queryable {
  unsafe(query: string): Promise<Row[]>;
}

interface Client extends Queryable {
  begin(fn: (tx: Queryable) => Promise<unknown>): Promise<unknown>;
  end(options?: { timeout?: number }): Promise<void>;
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

let cachedUrl: string | undefined;
let lock: Promise<void> = Promise.resolve();

/**
 * Returns the Data Layer pooler URL from `.dev.vars` without logging it.
 */
function databaseUrl(): string {
  if (cachedUrl) return cachedUrl;
  const text = Deno.readTextFileSync(new URL("../../.dev.vars", import.meta.url));
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("DATA_LAYER_DATABASE_URL=")) continue;
    const value = trimmed.slice("DATA_LAYER_DATABASE_URL=".length).trim();
    if (!value) throw new Error("DATA_LAYER_DATABASE_URL is empty");
    cachedUrl = value;
    return value;
  }
  throw new Error("DATA_LAYER_DATABASE_URL is missing from .dev.vars");
}

/**
 * Strips connection URLs and credential fields from a message.
 */
function redact(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(password|secret|token|api_key)=([^\s]+)/gi, "$1=[redacted]");
}

/**
 * Reads an error message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reads a SQLSTATE when the driver attached one.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Reads a text cell.
 */
function cell(row: Row, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Quotes a SQL identifier.
 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

/**
 * Quotes a SQL string literal.
 */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Qualifies a schema and relation.
 */
function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Opens one connection as karbon_data_reader.
 */
function openReader(): Client {
  const sql = postgres(databaseUrl(), {
    prepare: false,
    ssl: "require",
    max: 1,
    connect_timeout: 30,
    connection: { application_name: "data_layer_reader_test" },
    onnotice() {
      /* Privilege probes raise notices. Keep them out of the output. */
    },
  });
  return {
    unsafe: (query) => sql.unsafe(query),
    begin: (fn) => sql.begin((tx) => fn(tx)) as Promise<unknown>,
    end: (options) => sql.end(options),
  };
}

/**
 * Registers a test that runs after the previous one, so the login stays within its connection limit.
 */
function test(name: string, fn: (db: Client) => Promise<void>): void {
  Deno.test(name, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = lock;
    lock = gate;
    await previous;
    let db: Client | undefined;
    try {
      db = openReader();
      await fn(db);
    } finally {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        release();
      }
    }
  });
}

interface StatementOutcome {
  code: string | null;
  message: string;
}

/**
 * Runs a statement and returns its SQLSTATE, or null when it succeeds.
 * Rows are discarded so a successful probe cannot print table contents.
 */
async function statementOutcome(db: Queryable, statement: string): Promise<StatementOutcome> {
  try {
    await db.unsafe(statement);
    return { code: null, message: "" };
  } catch (error) {
    const code = errorCode(error);
    if (!code) {
      throw new Error(`statement failed without a SQLSTATE: ${redact(errorMessage(error))}`, { cause: error });
    }
    return { code, message: redact(errorMessage(error)) };
  }
}

/**
 * Returns the SQLSTATE of a failed statement, or null when it succeeds.
 */
async function sqlstateOf(db: Queryable, statement: string): Promise<string | null> {
  return (await statementOutcome(db, statement)).code;
}

/**
 * Asserts that a statement fails with one of the given SQLSTATE codes.
 */
async function expectFails(db: Queryable, statement: string, codes: readonly string[]): Promise<void> {
  const code = await sqlstateOf(db, statement);
  if (code === null || !codes.includes(code)) {
    throw new Error(`expected SQLSTATE ${codes.join(" or ")} but got ${code ?? "success"} for ${statement}`);
  }
}

/**
 * Runs fn in a transaction and always rolls it back.
 */
async function rolledBack<T>(db: Client, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  let result: T | undefined;
  let haveResult = false;
  try {
    await db.begin(async (tx) => {
      result = await fn(tx);
      haveResult = true;
      throw new RollbackSignal();
    });
  } catch (error) {
    if (error instanceof RollbackSignal && haveResult) return result as T;
    throw error;
  }
  throw new Error("transaction ended without rolling back");
}

/**
 * Asserts a statement fails, then rolls back to a savepoint so a later probe still runs.
 */
async function probe(tx: Queryable, statement: string, codes: readonly string[]): Promise<void> {
  await tx.unsafe("savepoint probe");
  try {
    await expectFails(tx, statement, codes);
  } finally {
    await tx.unsafe("rollback to savepoint probe");
  }
}

/**
 * Asserts the Data Layer event trigger rejected a statement, then rolls back to a savepoint.
 */
async function expectEventTriggerDenial(tx: Queryable, statement: string, tag: string): Promise<void> {
  await tx.unsafe("savepoint probe");
  try {
    const outcome = await statementOutcome(tx, statement);
    const expected = `Data Layer logins cannot run ${tag}`;
    if (outcome.code !== PERMISSION_DENIED || !outcome.message.includes(expected)) {
      throw new Error(
        `expected ${PERMISSION_DENIED} mentioning ${JSON.stringify(expected)} but got ${outcome.code ?? "success"}: ${outcome.message} for ${statement}`,
      );
    }
  } finally {
    await tx.unsafe("rollback to savepoint probe");
  }
}

/**
 * Starts a read-write transaction, runs fn, and rolls the transaction back.
 */
async function inReadWrite(db: Client, fn: (tx: Queryable) => Promise<void>): Promise<void> {
  await rolledBack(db, async (tx) => {
    await tx.unsafe("set transaction read write");
    await tx.unsafe("set default_transaction_read_only = off");
    const mode = await tx.unsafe("select current_setting('transaction_read_only') as mode");
    if (cell(mode[0], "mode") !== "off") {
      throw new Error(`transaction stayed ${cell(mode[0], "mode")} after set transaction read write`);
    }
    await fn(tx);
  });
}

interface Relation {
  schema: string;
  name: string;
  kind: string;
}

/**
 * Lists tables, views, and materialized views visible in one schema.
 */
async function relationsIn(db: Queryable, schema: string): Promise<Relation[]> {
  const rows = await db.unsafe(
    `select n.nspname as schema, c.relname as name, c.relkind as kind
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = ${quoteLiteral(schema)}
       and c.relkind in ('r', 'v', 'm', 'p', 'f')
     order by c.relname`,
  );
  return rows.map((row) => ({
    schema: cell(row, "schema"),
    name: cell(row, "name"),
    kind: cell(row, "kind"),
  }));
}

/**
 * Returns the first base table in f01_engineering and a column that can appear in an update probe.
 */
async function writeTarget(db: Queryable): Promise<{ table: string; column: string }> {
  const relations = await relationsIn(db, "f01_engineering");
  const table = relations.find((relation) => relation.kind === "r" || relation.kind === "p");
  if (!table) throw new Error("f01_engineering has no base table to probe");
  const columns = await db.unsafe(
    `select a.attname as name
     from pg_catalog.pg_attribute a
     join pg_catalog.pg_class c on c.oid = a.attrelid
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = ${quoteLiteral(table.schema)}
       and c.relname = ${quoteLiteral(table.name)}
       and a.attnum > 0
       and not a.attisdropped
       and a.attgenerated = ''
       and a.attidentity = ''
     order by a.attnum
     limit 1`,
  );
  if (columns.length === 0) throw new Error(`${table.schema}.${table.name} has no writable-looking column`);
  return {
    table: qualified(table.schema, table.name),
    column: quoteIdent(cell(columns[0], "name")),
  };
}

/**
 * Returns the first view in f01_engineering.
 */
async function firstView(db: Queryable): Promise<string> {
  const relations = await relationsIn(db, "f01_engineering");
  const view = relations.find((relation) => relation.kind === "v");
  if (!view) throw new Error("f01_engineering has no view to probe");
  return qualified(view.schema, view.name);
}

/**
 * Builds insert, update, delete, and truncate probes that cannot change a committed row.
 */
function writeStatements(table: string, column: string): string[] {
  return [
    `insert into ${table} select * from ${table} where false`,
    `update ${table} set ${column} = ${column} where false`,
    `delete from ${table} where false`,
    `truncate ${table}`,
  ];
}

test("current_user is karbon_data_reader and transaction_read_only is on", async (db) => {
  const rows = await db.unsafe(
    `select current_user as current_user,
            session_user as session_user,
            current_setting('transaction_read_only') as transaction_read_only,
            current_setting('default_transaction_read_only') as default_transaction_read_only,
            current_setting('statement_timeout') as statement_timeout,
            current_setting('idle_in_transaction_session_timeout') as idle_timeout,
            current_setting('search_path') as search_path,
            current_setting('is_superuser') as is_superuser`,
  );
  const row = rows[0];
  if (cell(row, "current_user") !== "karbon_data_reader") {
    throw new Error(`current_user is ${cell(row, "current_user")}`);
  }
  if (cell(row, "session_user") !== "karbon_data_reader") {
    throw new Error(`session_user is ${cell(row, "session_user")}`);
  }
  if (cell(row, "transaction_read_only") !== "on") {
    throw new Error(`transaction_read_only is ${cell(row, "transaction_read_only")}`);
  }
  if (cell(row, "default_transaction_read_only") !== "on") {
    throw new Error(`default_transaction_read_only is ${cell(row, "default_transaction_read_only")}`);
  }
  if (cell(row, "statement_timeout") !== "10s") {
    throw new Error(`statement_timeout is ${cell(row, "statement_timeout")}`);
  }
  if (cell(row, "idle_timeout") !== "15s") {
    throw new Error(`idle_in_transaction_session_timeout is ${cell(row, "idle_timeout")}`);
  }
  const searchPath = cell(row, "search_path").replaceAll("\"", "");
  if (searchPath !== "pg_catalog, f01_engineering") {
    throw new Error(`search_path is ${cell(row, "search_path")}`);
  }
  if (cell(row, "is_superuser") !== "off") {
    throw new Error(`is_superuser is ${cell(row, "is_superuser")}`);
  }
});

test("every f01_engineering relation can be read", async (db) => {
  const relations = await relationsIn(db, "f01_engineering");
  if (relations.length === 0) throw new Error("catalog listed no f01_engineering relations");
  for (const relation of relations) {
    const code = await sqlstateOf(db, `select 1 from ${qualified(relation.schema, relation.name)} limit 1`);
    if (code !== null) {
      throw new Error(`select from ${relation.schema}.${relation.name} failed with ${code}`);
    }
    const privileges = await db.unsafe(
      `select has_table_privilege(${quoteLiteral(qualified(relation.schema, relation.name))}, 'select') as select,
              has_table_privilege(${quoteLiteral(qualified(relation.schema, relation.name))}, 'insert') as insert,
              has_table_privilege(${quoteLiteral(qualified(relation.schema, relation.name))}, 'update') as update,
              has_table_privilege(${quoteLiteral(qualified(relation.schema, relation.name))}, 'delete') as delete,
              has_table_privilege(${quoteLiteral(qualified(relation.schema, relation.name))}, 'truncate') as truncate`,
    );
    const privilege = privileges[0];
    if (privilege.select !== true) throw new Error(`${relation.name} is missing select`);
    if (privilege.insert === true || privilege.update === true || privilege.delete === true || privilege.truncate === true) {
      throw new Error(`${relation.name} has a write privilege`);
    }
  }
  console.log(`report: f01_engineering relations readable: count=${relations.length}`);
});

test("data_freshness returns one row with last_successful_sync_at", async (db) => {
  const rows = await db.unsafe("select last_successful_sync_at from data_freshness");
  if (rows.length !== 1) throw new Error(`data_freshness returned ${rows.length} rows`);
  if (!("last_successful_sync_at" in rows[0])) throw new Error("last_successful_sync_at is missing");
});

test("information_schema.columns and col_description work for f01_engineering", async (db) => {
  const columns = await db.unsafe(
    "select count(*)::int as n from information_schema.columns where table_schema = 'f01_engineering'",
  );
  const count = Number(columns[0].n);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`information_schema.columns listed ${columns[0].n} f01_engineering columns`);
  }
  const described = await db.unsafe(
    `select (col_description(c.oid, a.attnum) is null) as description_null
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     join pg_catalog.pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'f01_engineering'
       and a.attnum > 0
       and not a.attisdropped
     limit 1`,
  );
  if (described.length !== 1 || typeof described[0].description_null !== "boolean") {
    throw new Error("col_description() did not return a value");
  }
  console.log(`report: information_schema.columns f01_engineering count=${count}`);
});

test("ingest, vault, auth, cron, storage, pg_authid, and pg_shadow reject select", async (db) => {
  const targets: string[] = [];
  for (const schema of DENIED_SCHEMAS) {
    const relations = await relationsIn(db, schema);
    if (relations.length === 0) throw new Error(`catalog listed no relations in ${schema}`);
    for (const relation of relations) targets.push(qualified(relation.schema, relation.name));
  }
  for (const [schema, name] of DENIED_RELATIONS) {
    const label = qualified(schema, name);
    if (!targets.includes(label)) targets.push(label);
  }
  for (const target of targets) {
    await expectFails(db, `select 1 from ${target} limit 1`, [PERMISSION_DENIED]);
  }
});

test("supabase_migrations.schema_migrations is not readable", async (db) => {
  const visible = await db.unsafe(
    "select to_regclass('supabase_migrations.schema_migrations') as relation",
  );
  const code = await sqlstateOf(db, "select 1 from supabase_migrations.schema_migrations limit 1");
  if (code === null) throw new Error("could read supabase_migrations.schema_migrations");
  if (cell(visible[0], "relation") === "" && code !== "42P01" && code !== "3F000" && code !== PERMISSION_DENIED) {
    throw new Error(`missing supabase_migrations.schema_migrations failed with ${code}`);
  }
  if (cell(visible[0], "relation") !== "" && code !== PERMISSION_DENIED) {
    throw new Error(`visible supabase_migrations.schema_migrations failed with ${code}`);
  }
  console.log(
    `report: supabase_migrations.schema_migrations to_regclass=${cell(visible[0], "relation") || "null"} select_sqlstate=${code}`,
  );
});

test("default read-only session rejects insert, update, delete, and truncate", async (db) => {
  const target = await writeTarget(db);
  const seen: string[] = [];
  await rolledBack(db, async (tx) => {
    const mode = await tx.unsafe("select current_setting('transaction_read_only') as mode");
    if (cell(mode[0], "mode") !== "on") throw new Error("expected the default transaction to be read only");
    for (const statement of writeStatements(target.table, target.column)) {
      await tx.unsafe("savepoint probe");
      try {
        const code = await sqlstateOf(tx, statement);
        if (code !== READ_ONLY_TRANSACTION && code !== PERMISSION_DENIED) {
          throw new Error(`expected SQLSTATE ${READ_ONLY_TRANSACTION} or ${PERMISSION_DENIED} but got ${code ?? "success"} for ${statement}`);
        }
        seen.push(`${statement.split(" ")[0]} ${code}`);
      } finally {
        await tx.unsafe("rollback to savepoint probe");
      }
    }
  });
  console.log(`report: default read-only writes: ${seen.join(", ")}`);
});

test("read-write session still rejects insert, update, delete, and truncate", async (db) => {
  const target = await writeTarget(db);
  await inReadWrite(db, async (tx) => {
    for (const statement of writeStatements(target.table, target.column)) {
      await probe(tx, statement, [PERMISSION_DENIED]);
    }
  });
});

test("read-write session rejects ddl and comment", async (db) => {
  const view = await firstView(db);
  await inReadWrite(db, async (tx) => {
    const statements = [
      "create table f01_engineering.cursor_priv_probe (id int)",
      "create table public.cursor_priv_probe (id int)",
      "create schema cursor_priv_probe",
      "create function f01_engineering.cursor_priv_probe() returns int language sql as 'select 1'",
      `alter view ${view} rename to cursor_priv_probe_view`,
      `drop view ${view}`,
      `comment on view ${view} is 'cursor privilege probe'`,
      "create role cursor_priv_probe nologin",
    ];
    for (const statement of statements) await probe(tx, statement, [PERMISSION_DENIED]);
  });
});

test("grant does not change f01_engineering privileges", async (db) => {
  const target = await writeTarget(db);
  const acls = async (tx: Queryable): Promise<{ schema: string; relation: string }> => {
    const rows = await tx.unsafe(
      `select
         (select nspacl::text from pg_namespace where nspname = 'f01_engineering') as schema_acl,
         (select relacl::text from pg_class where oid = ${quoteLiteral(target.table)}::regclass) as relation_acl`,
    );
    return { schema: cell(rows[0], "schema_acl"), relation: cell(rows[0], "relation_acl") };
  };
  await inReadWrite(db, async (tx) => {
    const grantOption = await tx.unsafe(
      `select has_schema_privilege('f01_engineering', 'usage with grant option') as schema,
              has_table_privilege(${quoteLiteral(target.table)}::regclass, 'select with grant option') as relation`,
    );
    if (grantOption[0].schema === true || grantOption[0].relation === true) {
      throw new Error("reader holds a grant option on f01_engineering");
    }
    const before = await acls(tx);
    const statements = [
      "grant usage on schema f01_engineering to public",
      `grant select on table ${target.table} to public`,
      `grant select on table ${target.table} to anon`,
    ];
    for (const statement of statements) await expectEventTriggerDenial(tx, statement, "GRANT");
    const after = await acls(tx);
    if (before.schema !== after.schema || before.relation !== after.relation) {
      throw new Error("grant changed an f01_engineering ACL");
    }
  });
});

test("read-write session rejects temp tables, grants, and comments from Data Layer logins", async (db) => {
  const target = await writeTarget(db);
  const view = await firstView(db);
  await inReadWrite(db, async (tx) => {
    await expectEventTriggerDenial(tx, "create temporary table cursor_priv_probe (id int)", "CREATE TABLE");
    await expectEventTriggerDenial(tx, `grant select on table ${target.table} to anon`, "GRANT");
    await expectEventTriggerDenial(tx, `comment on view ${view} is 'cursor privilege probe'`, "COMMENT");
  });
});

test("set role and set session authorization are rejected", async (db) => {
  const statements = [
    "set role ro_f01_engineering",
    "set role postgres",
    "set role supabase_admin",
    "set session authorization postgres",
  ];
  try {
    for (const statement of statements) await expectFails(db, statement, [PERMISSION_DENIED]);
  } finally {
    await db.unsafe("reset session authorization");
    await db.unsafe("reset role");
  }
});

test("server file and program access is rejected", async (db) => {
  await inReadWrite(db, async (tx) => {
    const statements = [
      "select pg_read_file('/etc/hostname')",
      "select pg_ls_dir('.')",
      "copy (select 1) to program 'true'",
      "select lo_import('/etc/hostname')",
    ];
    for (const statement of statements) await probe(tx, statement, [PERMISSION_DENIED]);
  });
});

test("default read-only session rejects create extension dblink schema extensions", async (db) => {
  const code = await rolledBack(db, async (tx) => {
    const mode = await tx.unsafe("select current_setting('transaction_read_only') as mode");
    if (cell(mode[0], "mode") !== "on") throw new Error("expected a read-only transaction");
    return await sqlstateOf(tx, "create extension dblink schema extensions");
  });
  if (code !== READ_ONLY_TRANSACTION) {
    throw new Error(`create extension dblink schema extensions returned ${code ?? "success"}`);
  }
});

test("KNOWN EXPOSURE: create extension dblink schema extensions in a rolled-back read-write transaction", async (db) => {
  await inReadWrite(db, async (tx) => {
    const outcome = await statementOutcome(tx, "create extension dblink schema extensions");
    if (outcome.code === null) {
      console.log(
        "KNOWN EXPOSURE: create extension dblink schema extensions succeeded in a read-write transaction; the transaction was rolled back",
      );
      return;
    }
    console.log(
      `KNOWN EXPOSURE: create extension dblink schema extensions in a read-write transaction failed with ${outcome.code}: ${outcome.message}; the transaction was rolled back`,
    );
  });
  const installed = await db.unsafe(
    "select count(*)::int as n from pg_catalog.pg_extension where extname = 'dblink'",
  );
  if (Number(installed[0].n) !== 0) {
    throw new Error("dblink is still installed after the rolled-back probe");
  }
});

test("read-only transaction rejects net.http_get", async (db) => {
  const code = await rolledBack(db, async (tx) => {
    const mode = await tx.unsafe("select current_setting('transaction_read_only') as mode");
    if (cell(mode[0], "mode") !== "on") throw new Error("expected a read-only transaction");
    return await sqlstateOf(tx, `select net.http_get(${quoteLiteral(PROBE_URL)})`);
  });
  if (code === null) throw new Error("net.http_get succeeded in a read-only transaction");
  console.log(`report: read-only net.http_get failed with ${code}`);
});

test("function calls outside granted schemas are rejected", async (db) => {
  await expectFails(db, "select auth.uid()", [PERMISSION_DENIED]);
  await expectFails(db, "select extensions.gen_random_uuid()", [PERMISSION_DENIED]);
  await inReadWrite(db, async (tx) => {
    await probe(tx, "select cron.schedule('cursor_priv_probe', '* * * * *', 'select 1')", [PERMISSION_DENIED]);
    await probe(tx, "select extensions.grant_pg_net_access()", [PERMISSION_DENIED]);
    await probe(tx, "select extensions.grant_pg_cron_access()", [PERMISSION_DENIED]);
  });
});

test("statement timeout cancels select pg_sleep(11)", async (db) => {
  await expectFails(db, "select pg_sleep(11)", [QUERY_CANCELED]);
});

test("KNOWN EXPOSURE: net queue reads and a rolled-back read-write http_get", async (db) => {
  for (const table of ["net.http_request_queue", "net._http_response"]) {
    try {
      const rows = await db.unsafe(`select count(*)::int as n from ${table}`);
      console.log(`KNOWN EXPOSURE: select count(*) from ${table} succeeded, count=${Number(rows[0].n)}`);
    } catch (error) {
      const code = errorCode(error);
      console.log(
        `KNOWN EXPOSURE: select count(*) from ${table} failed with ${code ?? "no SQLSTATE"}: ${redact(errorMessage(error))}`,
      );
    }
  }
  const privileges = await db.unsafe(
    `select has_function_privilege('net.http_get(text, jsonb, jsonb, integer)', 'execute') as http_get,
            has_function_privilege('net.worker_restart()', 'execute') as worker_restart`,
  );
  console.log(
    `KNOWN EXPOSURE: has_function_privilege net.http_get=${String(privileges[0].http_get)} net.worker_restart=${String(privileges[0].worker_restart)}`,
  );
  await inReadWrite(db, async (tx) => {
    const code = await sqlstateOf(tx, `select net.http_get(${quoteLiteral(PROBE_URL)})`);
    if (code === null) {
      console.log(
        "KNOWN EXPOSURE: net.http_get queued a request in a read-write transaction; the transaction was rolled back; target http://127.0.0.1:9/",
      );
      return;
    }
    console.log(
      `KNOWN EXPOSURE: net.http_get in a read-write transaction failed with ${code}; the transaction was rolled back; target http://127.0.0.1:9/`,
    );
  });
});

test("report: relation names visible in ingest and vault", async (db) => {
  for (const schema of ["ingest", "vault"]) {
    const relations = await relationsIn(db, schema);
    const names = relations.map((relation) => relation.name);
    console.log(
      `report: ${schema} relation names visible through pg_catalog: count=${names.length} names=${names.join(", ") || "(none)"}`,
    );
  }
});

test("report: pg_stat_activity for other roles", async (db) => {
  const rows = await db.unsafe(
    `select coalesce(usename, '<null>') as usename,
            coalesce(state, '<null>') as state,
            coalesce(backend_type, '<null>') as backend_type,
            count(*)::int as sessions,
            count(*) filter (where query is null)::int as query_null,
            count(*) filter (where query is not null)::int as query_visible,
            coalesce(min(length(query)), -1)::int as query_len_min,
            coalesce(max(length(query)), -1)::int as query_len_max
     from pg_stat_activity
     where usename is distinct from session_user
     group by 1, 2, 3
     order by 1, 2, 3`,
  );
  const privileges = await db.unsafe(
    `select pg_has_role('pg_read_all_stats', 'member') as stats,
            pg_has_role('pg_monitor', 'member') as monitor`,
  );
  console.log(
    `report: pg_stat_activity membership pg_read_all_stats=${String(privileges[0].stats)} pg_monitor=${String(privileges[0].monitor)}`,
  );
  if (rows.length === 0) {
    console.log("report: pg_stat_activity shows no sessions for other roles");
    return;
  }
  for (const row of rows) {
    console.log(
      `report: pg_stat_activity other role usename=${cell(row, "usename")} state=${cell(row, "state")} backend_type=${cell(row, "backend_type")} sessions=${cell(row, "sessions")} query_null=${cell(row, "query_null")} query_visible=${cell(row, "query_visible")} query_len_min=${cell(row, "query_len_min")} query_len_max=${cell(row, "query_len_max")}`,
    );
  }
});

test("no f01_engineering function is executable by this login", async (db) => {
  // Postgres grants EXECUTE on new functions to PUBLIC, and a per-schema ALTER DEFAULT PRIVILEGES
  // cannot revoke a global default. So this test is the guard: it fails as soon as a function in
  // f01_engineering becomes callable, and the function's grants get reviewed.
  const rows = await db.unsafe(
    `select count(*)::int as executable
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'f01_engineering'
       and has_function_privilege(p.oid, 'execute')`,
  );
  const executable = Number(rows[0].executable);
  if (executable !== 0) {
    throw new Error(`${executable} f01_engineering function(s) are executable by karbon_data_reader`);
  }
});

test("report: executable functions outside pg_catalog", async (db) => {
  const counts = await db.unsafe(
    `select n.nspname as schema, count(*)::int as executable
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where has_function_privilege(p.oid, 'execute')
       and n.nspname not in ('pg_catalog', 'information_schema')
     group by 1
     order by 1`,
  );
  if (counts.length === 0) {
    console.log("report: no executable functions outside pg_catalog and information_schema");
    return;
  }
  for (const row of counts) {
    console.log(`report: executable functions schema=${cell(row, "schema")} count=${cell(row, "executable")}`);
  }
});

test("no relation outside f01_engineering, the catalogs, and net is selectable", async (db) => {
  const rows = await db.unsafe(
    `select n.nspname as schema, c.relname as name
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
       and n.nspname not in ('f01_engineering', 'pg_catalog', 'information_schema', 'net')
       and n.nspname not like 'pg_toast%'
       and n.nspname not like 'pg_temp%'
     order by 1, 2`,
  );
  const readable: string[] = [];
  for (const row of rows) {
    const schema = cell(row, "schema");
    const name = cell(row, "name");
    const code = await sqlstateOf(db, `select 1 from ${qualified(schema, name)} limit 1`);
    if (code === null) readable.push(`${schema}.${name}`);
  }
  if (readable.length > 0) {
    throw new Error(`selectable relations outside the allow-list: ${readable.join(", ")}`);
  }
  console.log(`report: non-catalog relations checked and not selectable: count=${rows.length}`);
});

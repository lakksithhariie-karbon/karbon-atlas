// Postgres access for the Data Layer: one connection per call, every statement inside a READ ONLY
// transaction with the worker's own limits. README.md ("Query path", "Connection") has the design.

import postgres from "postgres";
import { RejectedError, checkColumnNames, checkPlan, checkText, shapeQuery, wrapQuery } from "./guard.js";
import { policyAllowsSchema } from "./policy.js";
import { openSocket } from "./socket.js";
import type {
  DataLayerColumn, DataLayerQueryResult, DataLayerRow, DataLayerSchema, DataLayerTable,
  DataLayerTableDetails, DataLayerValue,
} from "./types.js";

/** Longest database error message passed through to the caller. */
const MAX_ERROR_CHARS = 300;

/** Most rows `query()` returns. */
export const ROW_CAP = 500;
/** Longest any statement may run. */
export const STATEMENT_TIMEOUT = "30s";
/** Largest serialized result `query()` returns, in UTF-16 code units of its JSON. */
export const MAX_RESULT_CHARS = 5 * 1024 * 1024;

type Types = { date: string; timestamp: string; timestamptz: string };
type Sql = postgres.Sql<Types>;
type Tx = postgres.TransactionSql<Types>;

/**
 * Sends one statement over the extended protocol. postgres.js picks the simple protocol whenever
 * the parameter list is empty, and the simple protocol runs every statement in the string, so a
 * hidden `; commit; …` would leave the read-only transaction. The extended protocol refuses a
 * second statement (42601). Every statement this worker sends goes through here.
 */
function run<T extends readonly unknown[]>(tx: Tx, statement: string, params: readonly unknown[] = []) {
  return tx.unsafe<T extends postgres.Row[] ? T : never>(
    statement, params as never[], { prepare: false, simple: false } as postgres.UnsafeQueryOptions,
  );
}

// Postgres type OIDs the worker converts itself. Every other type keeps postgres.js's behaviour,
// which already returns int8, numeric and interval as text.
const OID = { bytea: 17, byteaArray: 1001, date: 1082, timestamp: 1114, timestamptz: 1184 } as const;

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2}(?::?\d{2}){0,2})?$/;

// `2026-11-19 18:00:05.123456+00` (the session is in UTC) as `2026-11-19T18:00:05.123Z`; a
// timestamp without a zone keeps no `Z`. Values JavaScript can't place (`infinity`, BC dates,
// years past 9999) stay as Postgres wrote them.
function isoTimestamp(raw: string, withZone: boolean): string {
  const m = TIMESTAMP.exec(raw);
  if (!m) return raw;
  const [, date, time, fraction = "", offset] = m;
  const ms = fraction.padEnd(3, "0").slice(0, 3);
  if (!withZone) return `${date}T${time}.${ms}`;
  if (offset === "+00" || offset === "+00:00") return `${date}T${time}.${ms}Z`;
  const parsed = new Date(`${date}T${time}.${ms}${normalizeOffset(offset ?? "+00")}`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function normalizeOffset(offset: string): string {
  const digits = offset.slice(1).replaceAll(":", "");
  return `${offset[0]}${digits.slice(0, 2)}:${(digits.slice(2, 4) || "00")}`;
}

const text = (oid: number, parse: (raw: string) => string) =>
  ({ to: oid, from: [oid], serialize: (value: unknown) => String(value), parse });

// postgres.js reads a `socket` factory at runtime, but its types don't declare one.
const SOCKET_OPTION: object = { socket: openSocket };

/** Opens the connection for one call. The caller must `end()` it. */
export function connect(url: string): Sql {
  return postgres(url, {
    ...SOCKET_OPTION,
    // Supabase's transaction pooler can't hold prepared statements between transactions.
    prepare: false,
    ssl: "require",
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { application_name: "karbon-data-layer" },
    // Replaces postgres.js's `date` parser, which turns all three of these into `Date`.
    types: {
      date: text(OID.date, raw => raw),
      timestamp: text(OID.timestamp, raw => isoTimestamp(raw, false)),
      timestamptz: text(OID.timestamptz, raw => isoTimestamp(raw, true)),
    },
  });
}

/**
 * Runs `fn` in a READ ONLY transaction with this worker's limits: the role's own defaults are only
 * defaults, so each transaction sets its statement timeout, an empty search path (`pg_catalog`
 * only, so every table must be schema-qualified) and UTC.
 */
async function readOnly<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return await sql.begin("read only", async tx => {
    await run(tx,
      "select set_config('statement_timeout', $1, true), set_config('search_path', 'pg_catalog', true), " +
        "set_config('TimeZone', 'UTC', true)",
      [STATEMENT_TIMEOUT],
    );
    return await fn(tx);
  }) as T;
}

/** The schemas the login can use, with which of them this caller may read. */
type SchemaAccess = { allowed: DataLayerSchema[]; others: string[] };

async function schemaAccess(tx: Tx): Promise<SchemaAccess> {
  const rows = await run<{ name: string; description: string | null }[]>(tx,
    "select n.nspname as name, obj_description(n.oid, 'pg_namespace') as description " +
      "from pg_namespace n where has_schema_privilege(n.oid, 'USAGE') order by n.nspname",
  );
  const allowed: DataLayerSchema[] = [];
  const others: string[] = [];
  for (const { name, description } of rows) {
    if (policyAllowsSchema(name)) allowed.push(description ? { name, description } : { name });
    else if (name !== "pg_catalog") others.push(name);
  }
  return { allowed, others };
}

/** Lists the schemas this caller may read. */
export async function listSchemas(sql: Sql): Promise<DataLayerSchema[]> {
  return await readOnly(sql, async tx => (await schemaAccess(tx)).allowed);
}

async function requireSchema(tx: Tx, schema: string): Promise<void> {
  const { allowed } = await schemaAccess(tx);
  if (!allowed.some(s => s.name === schema)) {
    throw new Error(`Schema \`${schema}\` is not readable. Readable schemas: ${allowed.map(s => s.name).join(", ") || "none"}.`);
  }
}

type TableRow = { name: string; kind: "table" | "view"; description: string | null; approx: string | null };

const TABLE_COLUMNS =
  "c.relname as name, case when c.relkind in ('v', 'm') then 'view' else 'table' end as kind, " +
  "obj_description(c.oid, 'pg_class') as description, " +
  "case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end as approx";

function toTable(schema: string, row: TableRow): DataLayerTable {
  return {
    schema,
    name: row.name,
    kind: row.kind,
    ...(row.description ? { description: row.description } : {}),
    approximateRowCount: row.approx === null ? null : Number(row.approx),
  };
}

/** Lists the tables and views in `schema` that the login can read. */
export async function listTables(sql: Sql, schema: string): Promise<DataLayerTable[]> {
  return await readOnly(sql, async tx => {
    await requireSchema(tx, schema);
    const rows = await run<TableRow[]>(tx,
      `select ${TABLE_COLUMNS} from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
        "where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(c.oid, 'SELECT') " +
        "order by kind, name",
      [schema],
    );
    return rows.map(row => toTable(schema, row));
  });
}

/** Describes one readable table or view. */
export async function describeTable(sql: Sql, schema: string, name: string): Promise<DataLayerTableDetails> {
  return await readOnly(sql, async tx => {
    await requireSchema(tx, schema);
    const rows = await run<(TableRow & { columns: DataLayerColumnRow[]; primary_key: string[] })[]>(tx,
      `select ${TABLE_COLUMNS},
        coalesce((select json_agg(json_build_object(
            'name', a.attname,
            'dataType', case when t.typcategory = 'A' then e.typname || '[]' else t.typname end,
            'nullable', not a.attnotnull,
            'description', col_description(c.oid, a.attnum)) order by a.attnum)
          from pg_attribute a
          join pg_type t on t.oid = a.atttypid
          left join pg_type e on e.oid = t.typelem
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::json) as columns,
        array(select a.attname::text from pg_index i
          cross join unnest(i.indkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where i.indrelid = c.oid and i.indisprimary order by k.ord) as primary_key
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(c.oid, 'SELECT')`,
      [schema, name],
    );
    const row = rows[0];
    if (!row) throw new Error(`There is no readable table or view \`${schema}.${name}\`.`);
    const columns: DataLayerColumn[] = row.columns.map(c => ({
      name: c.name, dataType: c.dataType, nullable: c.nullable,
      ...(c.description ? { description: c.description } : {}),
    }));
    return { ...toTable(schema, row), columns, primaryKey: row.primary_key };
  });
}

type DataLayerColumnRow = { name: string; dataType: string; nullable: boolean; description: string | null };

/** A checked query, ready to run. */
export type PreparedQuery = {
  /** The statement that runs: the caller's SQL inside the row-capped wrapper. */
  wrapped: string;
  params: DataLayerValue[];
  /** Allowed schemas the query reads, which its observation reports. */
  schemas: string[];
};

/**
 * Checks a caller's query without running it: the text pass, then `EXPLAIN (VERBOSE, FORMAT JSON)`
 * of the wrapped statement and the plan pass. A relation outside the allowed schemas passes only
 * when this login could not read it directly, which means it came from inside an allowed view.
 */
export async function prepareQuery(sql: Sql, query: string, params: DataLayerValue[]): Promise<PreparedQuery> {
  return await readOnly(sql, async tx => {
    const access = await schemaAccess(tx);
    const allowed = access.allowed.map(s => s.name);
    // Text first: planning evaluates stable functions, so nothing denied may reach EXPLAIN.
    const { body, schemasNamed } = checkText(query, allowed, access.others);
    const wrapped = wrapQuery(body, ROW_CAP);
    const explained = await run<{ "QUERY PLAN": unknown }[]>(tx, `EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`, params);
    const { relations } = checkPlan(explained[0]?.["QUERY PLAN"]);

    const schemas = new Set(schemasNamed);
    const outside: { schema: string; name: string }[] = [];
    for (const r of relations) {
      if (allowed.includes(r.schema)) schemas.add(r.schema);
      // The system catalogs hold owner-rights views too (pg_roles and pg_user scan pg_authid, which
      // the login can't read), so "can't read it directly" proves nothing there. No allowed view
      // reads a catalog.
      else if (SYSTEM_SCHEMAS.has(r.schema)) throw new RejectedError(`reading \`${r.schema}\` is not allowed; use listTables() and describeTable().`);
      else outside.push(r);
    }
    if (outside.length > 0) {
      // Views run with their owner's rights, so the plan of `data_freshness` scans `ingest`. A
      // relation the login can't read itself can only have come through such a view; one it can
      // read (pg_net's queue is granted to PUBLIC, and so are the system catalogs) is refused.
      const [{ readable }] = await run<{ readable: number }[]>(tx,
        // A catalog join, not to_regclass(): that raises 42501 for a schema the login can't use.
        "select count(*)::int as readable from unnest($1::text[], $2::text[]) as r(s, n) " +
          "left join pg_namespace ns on ns.nspname = r.s " +
          "left join pg_class c on c.relnamespace = ns.oid and c.relname = r.n " +
          "where c.oid is null or has_table_privilege(c.oid, 'SELECT') or has_any_column_privilege(c.oid, 'SELECT')",
        [outside.map(r => r.schema), outside.map(r => r.name)],
      ) as unknown as [{ readable: number }];
      if (readable > 0) {
        throw new RejectedError(`the query reads outside ${allowed.join(", ") || "the readable schemas"}.`);
      }
    }
    // The result's shape, checked before anything is recorded or read.
    const shape = await run<postgres.Row[]>(tx, shapeQuery(body), params);
    checkShape(shape.columns ?? []);
    return { wrapped, params, schemas: [...schemas] };
  });
}

const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(["pg_catalog", "information_schema", "pg_toast"]);

/** Refuses duplicate or `__proto__` column names, and bytea columns. */
function checkShape(meta: readonly { name: string; type: number }[]): void {
  checkColumnNames(meta.map(c => c.name));
  const bytea = meta.find(c => c.type === OID.bytea || c.type === OID.byteaArray);
  if (bytea) {
    throw new RejectedError(`column \`${bytea.name}\` is bytea, which is not returned. Select \`encode(${bytea.name}, 'hex')\` instead.`);
  }
}

/** Runs a prepared query and shapes its result. */
export async function runQuery(sql: Sql, prepared: PreparedQuery): Promise<DataLayerQueryResult> {
  const result = await readOnly(sql, tx => run<postgres.Row[]>(tx, prepared.wrapped, prepared.params));
  const meta = result.columns ?? [];
  // Checked again: prepareQuery's check ran in another transaction.
  checkShape(meta);
  const columns = meta.map(c => c.name);
  const truncated = result.length > ROW_CAP;
  const rows = (truncated ? result.slice(0, ROW_CAP) : [...result]) as DataLayerRow[];
  if (JSON.stringify(rows).length > MAX_RESULT_CHARS) {
    throw new RejectedError("the result is larger than about 5 MB. Select fewer columns, or aggregate in SQL.");
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

/**
 * Database errors carry Postgres's own message, which the caller can act on. Anything else (a
 * connection that failed, a timeout reaching the pooler) becomes a generic message, so nothing
 * about the connection string reaches the caller.
 */
export function publicError(error: unknown): Error {
  if (error instanceof RejectedError) return error;
  if (error instanceof postgres.PostgresError) {
    // A long message is usually one quoting a value (a cast error over a whole document). Keep the
    // SQLSTATE, drop the text.
    const e = new Error(error.message.length > MAX_ERROR_CHARS
      ? `Database error ${error.code} (message too long to show).` : error.message);
    (e as { code?: string }).code = error.code;
    return e;
  }
  if (error instanceof Error && /^(Schema|There is no) /.test(error.message)) return error;
  return new Error("The Data Layer could not reach its database. Try again shortly.");
}

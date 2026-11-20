// The query guard: what `DataLayer.query()` checks before any of the caller's SQL reaches Postgres,
// and what it checks in Postgres's own plan before the query runs. README.md ("Query path")
// explains why there are two passes. Pure functions, so the tests can drive them directly.

/** A rule break, reported to the caller with the `Rejected:` prefix `types.d.ts` promises. */
export class RejectedError extends Error {
  constructor(reason: string) {
    super(`Rejected: ${reason}`);
    this.name = "RejectedError";
  }
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

/** One SQL token. Comments and whitespace are dropped; string contents are never inspected. */
export type Token =
  | { kind: "word"; value: string } // an unquoted identifier or keyword, lowercased
  | { kind: "quoted"; value: string } // a "quoted identifier", exactly as Postgres reads it
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "param" }
  | { kind: "punct"; value: string; at: number };

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Splits SQL into tokens the way Postgres's lexer does for everything that matters here: nested
 * block comments, line comments, standard and `E''` strings, dollar quoting, quoted identifiers
 * and positional parameters. Throws `RejectedError` on what it can't read safely: an unterminated
 * comment, string or identifier, and `U&` Unicode escapes, which could spell a denied name.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) throw new RejectedError("the query has an unterminated /* comment.");
      continue;
    }
    if ((c === "u" || c === "U") && next === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      throw new RejectedError("U& Unicode escapes are not allowed.");
    }
    if (c === "'" || ((c === "e" || c === "E") && next === "'")) {
      i = skipString(sql, c === "'" ? i : i + 1, c !== "'");
      tokens.push({ kind: "string" });
      continue;
    }
    if (/[bBxXnN]/.test(c) && next === "'") {
      i = skipString(sql, i + 1, false);
      tokens.push({ kind: "string" });
      continue;
    }
    if (c === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= n) throw new RejectedError("the query has an unterminated quoted identifier.");
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += sql[i];
        i++;
      }
      tokens.push({ kind: "quoted", value });
      continue;
    }
    if (c === "$") {
      if (next !== undefined && /[0-9]/.test(next)) {
        i += 2;
        while (i < n && /[0-9]/.test(sql[i]!)) i++;
        tokens.push({ kind: "param" });
        continue;
      }
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw new RejectedError("the query has an unterminated dollar-quoted string.");
        i = end + tag[0].length;
        tokens.push({ kind: "string" });
        continue;
      }
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      tokens.push({ kind: "word", value: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) {
        // A sign right after an exponent marker belongs to the number.
        if ((sql[j] === "e" || sql[j] === "E") && (sql[j + 1] === "+" || sql[j + 1] === "-")) j++;
        j++;
      }
      tokens.push({ kind: "number" });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: c, at: i });
    i++;
  }
  return tokens;
}

// Returns the index just past the string whose opening quote is at `start`. In an `E''` string a
// backslash escapes the next character; in a standard one (standard_conforming_strings is on, the
// default since Postgres 9.1) it is literal. `''` is a quote in both.
function skipString(sql: string, start: number, backslashEscapes: boolean): number {
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) throw new RejectedError("the query has an unterminated string.");
    const c = sql[i];
    if (backslashEscapes && c === "\\") { i += 2; continue; }
    if (c === "'") {
      if (sql[i + 1] === "'") { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
}

/** The name a word or quoted token spells, for matching against deny lists. */
function nameOf(token: Token): string | undefined {
  return token.kind === "word" ? token.value : token.kind === "quoted" ? token.value.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------------------------
// Deny lists
// ---------------------------------------------------------------------------------------------

/**
 * Functions `query()` refuses: they run SQL from a string, reach outside the query (network, files,
 * other sessions), read server settings, wait, or take locks. Matched on the bare name, wherever it
 * appears, so a schema prefix or quoting does not get one through.
 */
const DENIED_FUNCTIONS: readonly RegExp[] = [
  /^(query|cursor|table|schema|database)_to_xml/, /xmlschema$/,
  /^ts_(stat|rewrite)$/,
  /^dblink/, /^http(_(get|post|put|patch|delete|head|request|header|list_curlopt|reset_curlopt|set_curlopt))?$/,
  /^(set_config|current_setting)$/,
  // Every pg_* function: server control, files, locks, sleeps, statistics, and catalog text
  // (`pg_get_viewdef` and friends) that planning would evaluate and an error could quote. Analytics
  // has no use for them. `pg_catalog` itself is a schema name, allowed as a qualifier.
  /^pg_(?!catalog$|typeof$|column_size$)/,
  /^(obj|col|shobj)_description$/, /^inet_(server|client)_(addr|port)$/,
  /^(http_collect_response|_http_collect_response|_await_response|worker_restart|wake|check_worker_is_up|wait_until_running)$/,
  /^lo_(import|export|open|close|creat|create|unlink|get|put|from_bytea|lseek|lseek64|tell|tell64|truncate|truncate64|read|write)$/,
  /^(nextval|setval|currval|lastval)$/, /^current_query$/,
  /^txid_current/, /^pg_current_xact_id/,
];

/**
 * Words that only appear in statements other than a read. Postgres refuses all of these inside
 * the read-only wrapper anyway; matching them here gives the caller a clear reason. Only unquoted
 * words count, so a column quoted as `"update"` stays readable.
 */
const DENIED_KEYWORDS: ReadonlySet<string> = new Set([
  "insert", "update", "delete", "merge", "truncate", "into", "copy", "grant", "revoke", "create",
  "alter", "drop", "lock", "listen", "notify", "unlisten", "vacuum", "prepare", "execute",
  "deallocate", "discard", "call", "do", "begin", "commit", "rollback", "savepoint", "release",
  "share", "nowait", "checkpoint", "cluster", "reindex", "refresh", "security", "import",
]);

/** System and Supabase schemas, refused by name even where the login cannot use them. */
export const ALWAYS_DENIED_SCHEMAS: readonly string[] = [
  "information_schema", "pg_toast", "net", "vault", "auth", "cron", "storage", "realtime",
  "extensions", "graphql", "graphql_public", "pgsodium", "pgsodium_masks", "supabase_functions",
  "supabase_migrations", "pgbouncer", "ingest", "karbon_guard", "public",
];

const FIRST_WORDS: ReadonlySet<string> = new Set(["select", "with", "values", "table"]);

/** What the text pass found: the SQL to wrap, and which allowed schemas it names. */
export type TextCheck = {
  /** The caller's SQL without its one optional trailing semicolon. */
  body: string;
  /** Allowed schemas the SQL names as an identifier anywhere, in first-seen order. */
  schemasNamed: string[];
};

/**
 * The text pass. It runs before Postgres sees the SQL, because planning already evaluates stable
 * functions with constant arguments (`table_to_xml('…')` in a `WHERE`), and an error raised there
 * can quote what the function read. So everything that can call a denied function or name a denied
 * schema is refused by name first; the plan pass then checks what Postgres resolved.
 * @param allowedSchemas Schemas this caller may read.
 * @param deniedSchemas Other schemas to refuse by name (every schema the login can use that is not
 *   allowed, besides `ALWAYS_DENIED_SCHEMAS`).
 */
export function checkText(sql: string, allowedSchemas: readonly string[], deniedSchemas: readonly string[] = []): TextCheck {
  const tokens = tokenize(sql);
  let body = sql;
  const last = tokens.at(-1);
  if (last?.kind === "punct" && last.value === ";") {
    tokens.pop();
    body = sql.slice(0, last.at);
  }
  if (tokens.length === 0) throw new RejectedError("the query is empty.");
  if (tokens.some(t => t.kind === "punct" && t.value === ";")) {
    throw new RejectedError("query() runs one statement; this has more than one.");
  }
  // A `)` with no `(` before it would close the wrapper's subquery, and an unclosed `(` would be
  // closed by it, letting `select 1) union all select … from (select 1` run outside the wrapper.
  let depth = 0;
  for (const t of tokens) {
    if (t.kind !== "punct") continue;
    if (t.value === "(") depth++;
    else if (t.value === ")" && --depth < 0) break;
  }
  if (depth !== 0) throw new RejectedError("the query's parentheses don't balance.");
  const first = tokens.find(t => !(t.kind === "punct" && t.value === "("));
  if (!first || first.kind !== "word" || !FIRST_WORDS.has(first.value)) {
    throw new RejectedError("query() runs one SELECT, WITH … SELECT, VALUES or TABLE statement.");
  }

  const allowed = new Set(allowedSchemas);
  const denied = new Set([...ALWAYS_DENIED_SCHEMAS, ...deniedSchemas].filter(s => !allowed.has(s)));
  const schemasNamed: string[] = [];
  for (const token of tokens) {
    const name = nameOf(token);
    if (name === undefined) continue;
    if (token.kind === "word" && DENIED_KEYWORDS.has(name)) {
      throw new RejectedError(`query() is read-only and does not accept \`${name.toUpperCase()}\`.`);
    }
    if (DENIED_FUNCTIONS.some(re => re.test(name))) {
      throw new RejectedError(`\`${name}\` is not allowed: it can reach outside the query, run SQL from a string, read server settings, wait or take locks.`);
    }
    if (denied.has(name)) {
      throw new RejectedError(`schema \`${name}\` is not readable. Readable schemas: ${[...allowed].join(", ") || "none"}. (A table alias with this name is refused too; rename it.)`);
    }
    if (allowed.has(name) && !schemasNamed.includes(name)) schemasNamed.push(name);
  }
  return { body, schemasNamed };
}

/**
 * The statement that actually runs: the caller's SQL as a subquery, one row past the cap so a
 * truncated result is visible. The line breaks keep a trailing `--` comment from swallowing the
 * wrapper's closing parenthesis.
 */
export function wrapQuery(body: string, rowCap: number): string {
  return `SELECT * FROM (\n${body}\n) AS q LIMIT ${rowCap + 1}`;
}

/**
 * The same statement with `LIMIT 0`: Postgres returns its columns and their types without reading a
 * row (the Limit node never pulls from its child), so the result's shape can be checked before the
 * observation is recorded.
 */
export function shapeQuery(body: string): string {
  return `SELECT * FROM (\n${body}\n) AS q LIMIT 0`;
}

// ---------------------------------------------------------------------------------------------
// Plan pass
// ---------------------------------------------------------------------------------------------

/** A table, view or function scan in the plan. */
export type PlanRelation = { schema: string; name: string };

/** What the plan pass found. */
export type PlanCheck = {
  /** Every relation the plan scans, after view expansion. */
  relations: PlanRelation[];
};

/** Set-returning functions a query may read from (`FROM generate_series(…)`). */
const FUNCTION_SCANS: ReadonlySet<string> = new Set([
  "generate_series", "generate_subscripts", "unnest", "regexp_matches", "regexp_split_to_table",
  "string_to_table", "json_each", "json_each_text", "jsonb_each", "jsonb_each_text",
  "json_array_elements", "json_array_elements_text", "jsonb_array_elements",
  "jsonb_array_elements_text", "json_object_keys", "jsonb_object_keys", "json_to_record",
  "json_to_recordset", "jsonb_to_record", "jsonb_to_recordset", "json_populate_record",
  "json_populate_recordset", "jsonb_populate_record", "jsonb_populate_recordset",
  "jsonb_path_query",
]);

// Plan keys whose values are names, not expressions.
const NAME_KEYS: ReadonlySet<string> = new Set([
  "Node Type", "Relation Name", "Schema", "Alias", "Index Name", "CTE Name", "Function Name",
  "Subplan Name", "Parent Relationship", "Strategy", "Join Type", "Scan Direction", "Partial Mode",
  "Operation", "Command", "Sort Method", "Sort Space Type", "Hash Key Type", "Table Function Name",
]);

/**
 * The plan pass, over `EXPLAIN (VERBOSE, FORMAT JSON)` of the wrapped statement. Postgres has
 * resolved every name and expanded every view by now, and dropped comments. It refuses row locks
 * and writes, function scans outside `pg_catalog`, schema-qualified function calls and operators
 * outside `pg_catalog`, and denied functions anywhere in an expression. It returns the relations
 * scanned; the caller decides which of those are allowed.
 */
export function checkPlan(explain: unknown): PlanCheck {
  const relations: PlanRelation[] = [];
  const visit = (node: unknown, key?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const type = record["Node Type"];
      if (type === "LockRows" || type === "ModifyTable") {
        throw new RejectedError("query() is read-only: row locks (FOR UPDATE / FOR SHARE) and writes are not allowed.");
      }
      if (typeof record["Relation Name"] === "string") {
        relations.push({ schema: String(record["Schema"] ?? ""), name: record["Relation Name"] });
      }
      if (typeof record["Function Name"] === "string") {
        const schema = String(record["Schema"] ?? "");
        const name = record["Function Name"];
        // An allowlist: catalog views (pg_settings, pg_prepared_statements, pg_locks, …) expand to
        // function scans of internal functions, and none of them belongs in a company-data query.
        if (schema !== "pg_catalog" || !FUNCTION_SCANS.has(name)) {
          throw new RejectedError(`reading from \`${schema}.${name}\` is not allowed.`);
        }
        checkFunctionName(name);
      }
      for (const [k, v] of Object.entries(record)) {
        if (!NAME_KEYS.has(k)) visit(v, k);
      }
      return;
    }
    if (typeof node === "string" && key !== undefined) checkExpression(node);
  };
  visit(explain);
  return { relations };
}

function checkFunctionName(name: string): void {
  const lower = name.toLowerCase();
  if (DENIED_FUNCTIONS.some(re => re.test(lower))) throw new RejectedError(`\`${lower}\` is not allowed.`);
}

// An expression as EXPLAIN VERBOSE deparses it. Names outside the search path (`pg_catalog` only)
// come out schema-qualified, so any qualifier other than pg_catalog on a call or operator is a
// function from another schema.
function checkExpression(text: string): void {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch {
    // Deparsed expressions always lex; one that doesn't is not something to run.
    throw new RejectedError("the query's plan could not be checked.");
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const name = nameOf(t);
    if (name === undefined) continue;
    const open = tokens[i + 1];
    const isCall = open?.kind === "punct" && open.value === "(";
    if (name === "operator" && isCall) {
      const schema = nameOf(tokens[i + 2] ?? { kind: "number" });
      const dot = tokens[i + 3];
      if (dot?.kind === "punct" && dot.value === "." && schema !== "pg_catalog") {
        throw new RejectedError(`operators from schema \`${schema}\` are not allowed.`);
      }
      continue;
    }
    if (!isCall) continue;
    checkFunctionName(name);
    const dot = tokens[i - 1];
    if (dot?.kind === "punct" && dot.value === ".") {
      const schema = nameOf(tokens[i - 2] ?? { kind: "number" });
      if (schema !== "pg_catalog") throw new RejectedError(`function \`${schema}.${name}\` is not allowed.`);
    }
  }
}

/** Throws unless every column name in a result is distinct. */
export function checkColumnNames(columns: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of columns) {
    if (name === "__proto__") throw new RejectedError("a column may not be named `__proto__`; alias it.");
    if (seen.has(name)) {
      throw new RejectedError(`the result has two columns named \`${name}\` (often \`select *\` over a join). List the columns, or alias them.`);
    }
    seen.add(name);
  }
}

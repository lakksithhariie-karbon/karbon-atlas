# Data Layer

Karbon-only. Not part of upstream Cloudflare OS.

An auto-provisioned ("ambient") gatekeeper whose account gives every signed-in user's agent and
Gadgets a `DATA_LAYER` binding: read-only SQL over Karbon's company data in Supabase, with no
OAuth and no per-chat approval. The API is `src/types.d.ts`. This file is the design record.

**Status:** Phase 2 (API review). The database roles exist; the worker is not built yet.

## Model

- **One schema per company function**, `f<NN>_<function>`. Today only `f01_engineering` (Jira).
  A new function schema becomes readable by granting it to a group role. No connector code changes.
- **Ambient, like Web Search.** `GatekeeperVendor.describe()` sets `autoProvisionsAccount: true`.
  The account's singleton (`suggestedBindingName: "DATA_LAYER"`) is folded into every chat's env.
  An admin sets the `datalayer` mode to `enabled` (the default is `optional`).

## Access is enforced by Postgres

The worker connects as `karbon_data_reader`. It holds no privileges of its own; it inherits a group
role per access level and cannot `SET ROLE` (`supabase/migrations/20261119200000_data_layer_reader.sql`).

| Role | Login | Holds |
|---|---|---|
| `ro_f01_engineering` | no | `USAGE` on `f01_engineering`, `SELECT` on every table and view (default privileges cover future ones) |
| `karbon_data_reader` | yes | Membership in `ro_f01_engineering` (inherit, no set) |

- An event trigger rejects DDL, `GRANT` and `REVOKE` from Data Layer logins.
- The password is set out of band, as a pre-hashed SCRAM verifier, and never stored in git.
- **Two Supabase platform defaults can't be closed by the project's `postgres` role:** `pg_net`
  (schema `net`) is granted to `PUBLIC`, and supautils installs allowed extensions for any role.
  So the read-only transaction and the query checks below are load-bearing, not extras, and the
  login's credential lives only in the worker.
- Role defaults (`default_transaction_read_only`, `statement_timeout`, `search_path`) are only
  defaults, because a session can change them. The worker sets its own limits on every query (below).
- Views run with their owner's rights. That is how `data_freshness` reports sync times without
  granting the raw schema. Any view added to an `f<NN>_` schema therefore exposes what it selects,
  so views are reviewed like grants.

## Query path (Phase 3)

Each `query()`:

1. **Validates against Postgres's own parse, never regexes.** Regexes are what a comment defeats
   (`net/**/.http_get(...)`). The query is accepted only if it is one `SELECT` / `WITH` /
   `VALUES` / `TABLE` statement (one trailing semicolon stripped), with no data-modifying `WITH`,
   `SELECT INTO` or locking clause. Then every relation it reads, after view expansion, is mapped back to an allowed
   schema, or to a relation an allowed schema's view reads. Every function it calls must be off
   the deny list in `types.d.ts`. The parse is either `EXPLAIN (VERBOSE, FORMAT JSON)` in the same
   read-only transaction, where Postgres resolves names and strips comments, or a libpg_query
   parser. Phase 3 picks one, with tests of both kinds of input.
2. **Records the observation** before returning data (see below).
3. **Runs** inside `BEGIN READ ONLY`, with `SET LOCAL statement_timeout = '30s'` and
   `SET LOCAL search_path = pg_catalog, <allowed schemas>`, as
   `SELECT * FROM (<sql>) AS q LIMIT 501` over the **extended protocol** (`postgres.js`
   `unsafe(text, params ?? [], { simple: false })`). With no parameters, `postgres.js` would
   otherwise use the simple protocol, which runs every statement in the string:
   `select 1); select 99 --` escapes the wrapper there, and then a `commit` leaves the read-only
   transaction (shown live by Cursor's review). The extended protocol refuses a second statement
   (`42601`). The 501st row sets `truncated`.
4. **Rejects** results with duplicate column names, and caps the serialized result at about 5 MB.

**Why the read-only transaction is load-bearing.** The login can read `net` (pg_net) and can install
extensions through supautils, and the project's `postgres` role can't revoke either. Inside a
read-only transaction neither can do harm: pg_net can't queue a request and `CREATE EXTENSION`
fails (`25006`). The parse check keeps the `net` tables themselves unread.

**Values:** `postgres.js` 3.4.5 keeps `int8`, `numeric` and `interval` as text, which matches
`types.d.ts`. Its default `date` / `timestamp` / `timestamptz` parsers return `Date`, which
doesn't match. Custom `types` keep `date` as `YYYY-MM-DD`, give `timestamp` as ISO-8601 with no
zone and `timestamptz` through `toISOString()`, and reject `bytea`.

**Performance prerequisite.** The golden "AP bugs stuck in UAT" query
(`jira_issue_status_periods` joined to `jira_issue_lifecycle`, filtered on `product_areas`) takes
about 23 s, because the filter applies only after the view builds all ~30,000 status stints. The
other golden queries take under 0.4 s. Phase 3 adds a cheap current-status read: the current
stint is `status_changed_at` on the issue, so no window over the changelog is needed. With that,
30 s is a ceiling, not the expected time.

**Connection:** direct Postgres over TCP, through Supabase's transaction pooler (port 6543), with
`postgres.js` (`prepare: false`; the pooler can't use prepared statements). Workers can't reuse a
connection across requests, so each call opens one. Production should front it with Hyperdrive.
Locally the URL comes from `DATA_LAYER_DATABASE_URL` in the root `.dev.vars`. The login's
`connection limit 10` is the backpressure: an 11th concurrent query fails with `53300`.

## Sharing and observers

This follows the new-gatekeeper observer contract in `.agents/skills/write-gatekeeper/SKILL.md`:

- **Subresources:** every read reports the schemas it disclosed, built with
  `formatSubresourceId()`: `schema/f01_engineering`. A single-schema read is strategy B. A read
  across schemas, or `listSchemas()`, reports every schema (strategy C). Only a statement that
  reads no relation (`select 1`) reports `[]`. Not `GLOBAL_SUBRESOURCE_ID`: per-department rules
  would need a migration away from it. A view is reported by its own schema, never by what it
  reads. `data_freshness` is `schema/f01_engineering`, not `schema/ingest`.
- **Whose policy:** the ambient capsule runs on the **workspace owner's** account, so `listSchemas()`
  and `query()` apply the owner's policy. `verifyObserverAccess()` must instead ask each
  **observer's own verifier** (`getVerifier()` on their Data Layer account) whether that person's
  policy allows every reported schema. It must never read the capsule's owner props. Unknown ID
  shapes throw. A definite "no" leaves the observer out of `allowedObserverIds`. A policy that
  can't be evaluated throws. Today the policy is "every user of this deployment may read
  `f01_engineering`"; per-department rules replace that one function.
- **Do not copy Web Search here.** It reports `[]` and admits everyone, which is right only for
  public data. An empty list is committed without any check.
- `addObserver()` / `removeObserver()` are no-ops; `getHistoricalSubresources()` returns `[]`.
- **The mode must be `enabled`.** In `optional` mode a collaborator may have no Data Layer account,
  so they have no verifier and can't be admitted to a workspace that has read a schema.
- **What sharing checks.** Collaborators with `build` access are verified against everything the
  workspace read. A `use` collaborator of one Gadget is checked against that Gadget's bindings,
  not against chat-only reads (`docs/observers.md`). So a Gadget that shows company data should
  bind `DATA_LAYER` instead of copying rows into its code (`types.d.ts` says so).
- Observations do not set `containsRestrictedData`. Setting it would force manual approval of
  every action, and block web fetches, in any workspace that ever read engineering metrics. A
  schema's policy can set it later (for finance, say).
- **Share links:** joining through a link adds the person as a collaborator on their own account
  on this deployment. There are no anonymous viewers. With signups off, every possible observer is
  a Karbon account the admin created.

## Out of scope

Writes, per-department rules (only the policy seam exists), Microsoft Entra sign-in, and
production hosting.

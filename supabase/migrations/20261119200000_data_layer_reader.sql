-- Karbon-only. Read-only database access for the Data Layer gatekeeper (env.DATA_LAYER).
--
-- Two roles, one per job:
--   ro_f01_engineering  A group role (no login) holding read access to f01_engineering. One group
--                       role per access level; a later function schema (f02_product, ...) gets its own.
--   karbon_data_reader  The login the Data Layer connects as. It inherits ro_f01_engineering's
--                       privileges but cannot SET ROLE to it or to anything else.
--
-- The login is created without a password, so it cannot connect until one is set out of band
-- (pre-hashed SCRAM through the Management API). No password belongs in this public repo, and a
-- plaintext ALTER ROLE ... PASSWORD would be written to the Postgres logs (log_statement = ddl).
--
-- The role defaults below (read-only transactions, timeouts, search_path) are defaults, not a
-- security boundary: a session can change them. The boundary is the privileges. The Data Layer also
-- wraps every query in BEGIN READ ONLY with SET LOCAL limits.
--
-- Safe to run twice.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ro_f01_engineering') then
    create role ro_f01_engineering nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'karbon_data_reader') then
    create role karbon_data_reader login;
  end if;
end
$$;

-- New roles already default to NOSUPERUSER, NOREPLICATION and NOBYPASSRLS, and only a superuser may
-- set those attributes (even to false), so they are checked after applying rather than set here.
alter role ro_f01_engineering nologin nocreatedb nocreaterole;

alter role karbon_data_reader login nocreatedb nocreaterole inherit connection limit 10;

alter role karbon_data_reader set default_transaction_read_only = on;
alter role karbon_data_reader set statement_timeout = '10s';
alter role karbon_data_reader set idle_in_transaction_session_timeout = '15s';
-- pg_catalog first, so nothing created in f01_engineering can shadow a built-in.
alter role karbon_data_reader set search_path = pg_catalog, f01_engineering;

-- Inherit the group's privileges; never switch into it (SET ROLE) or administer it.
grant ro_f01_engineering to karbon_data_reader with inherit true, set false, admin false;

-- Read access to f01_engineering: every table and view, now and later. Views run with their owner's
-- rights, so data_freshness can report sync times from ingest without granting ingest itself.
grant usage on schema f01_engineering to ro_f01_engineering;
grant select on all tables in schema f01_engineering to ro_f01_engineering;
alter default privileges for role postgres in schema f01_engineering
  grant select on tables to ro_f01_engineering;
-- Postgres grants EXECUTE on new functions to PUBLIC, and a per-schema ALTER DEFAULT PRIVILEGES
-- cannot revoke that global default (a global revoke would change every function postgres creates).
-- f01_engineering has no functions. supabase/tests/data_layer_reader_test.ts fails if one becomes
-- executable by the Data Layer login, so any future function gets its grants reviewed.

-- An event trigger rejects every DDL command, GRANT and REVOKE included, from any Data Layer login
-- (karbon_data_*), so even a read-write session can't create temp tables or try grants.
-- It cannot stop CREATE EXTENSION: Supabase's supautils runs an allowed extension's install as an
-- admin role, and event triggers are skipped for it. Only a read-only transaction blocks that
-- (SQLSTATE 25006), which is why the Data Layer runs every query in one.
create schema if not exists karbon_guard;
revoke all on schema karbon_guard from public;
comment on schema karbon_guard is 'Karbon-only. Database guards (event triggers). No data.';

create or replace function karbon_guard.reject_data_reader_ddl()
returns event_trigger
language plpgsql
as $fn$
begin
  if session_user::text like 'karbon\_data\_%' or current_user::text like 'karbon\_data\_%' then
    raise exception 'permission denied: Data Layer logins cannot run %', tg_tag
      using errcode = '42501';
  end if;
end
$fn$;
revoke all on function karbon_guard.reject_data_reader_ddl() from public;

drop event trigger if exists karbon_reject_data_reader_ddl;
create event trigger karbon_reject_data_reader_ddl
  on ddl_command_start
  execute function karbon_guard.reject_data_reader_ddl();

comment on role ro_f01_engineering is
  'Karbon Data Layer: read access to f01_engineering (tables and views). No login.';
comment on role karbon_data_reader is
  'Karbon Data Layer login. Inherits ro_f01_engineering; cannot SET ROLE. Password set out of band.';

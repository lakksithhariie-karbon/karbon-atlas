-- Schema for the Engineering function's data (first source: Jira project AiA / SPEND).
--
-- Naming: f<NN>_<function>, so schemas sort in a fixed order and need no quoting.
-- Access: no grants to anon or authenticated. The schema is not exposed through the
-- Supabase Data API until a later migration decides who may read it.

create schema if not exists f01_engineering;

comment on schema f01_engineering is
  'Engineering function data. Clean, query-ready tables only; raw payloads and sync state live elsewhere.';

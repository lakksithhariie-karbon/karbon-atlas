-- Scheduling and outbound HTTP for the Jira sync.
-- Idempotent: enabling an extension that is already installed does nothing.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Schedule the Jira sync. The jobs read the project URL and the function auth secret from Vault
-- (jira_sync_project_url and jira_sync_auth_secret). Create those secrets before relying on the jobs.
-- A second apply leaves an existing job as it is.

do $$
declare
  incremental_command text := $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'jira_sync_project_url') || '/functions/v1/jira-sync',
      body := '{"mode":"incremental"}'::jsonb,
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-jira-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jira_sync_auth_secret')
      ),
      timeout_milliseconds := 150000
    );
  $cmd$;
  nightly_command text := $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'jira_sync_project_url') || '/functions/v1/jira-sync',
      body := '{"mode":"nightly"}'::jsonb,
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-jira-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jira_sync_auth_secret')
      ),
      timeout_milliseconds := 150000
    );
  $cmd$;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed';
  end if;
  if not exists (select 1 from cron.job where jobname = 'jira-sync-incremental') then
    perform cron.schedule('jira-sync-incremental', '*/30 * * * *', incremental_command);
  end if;
  if not exists (select 1 from cron.job where jobname = 'jira-sync-nightly') then
    perform cron.schedule('jira-sync-nightly', '30 20 * * *', nightly_command);
  end if;
end $$;

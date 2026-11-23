-- Schedule the Mixpanel sync. The jobs read the project URL (jira_sync_project_url, shared with the
-- Jira jobs) and the function's shared secret (mixpanel_sync_auth_secret) from Vault. Create the
-- secret before relying on the jobs. A second apply leaves an existing job as it is.
--
--   mixpanel-sync-incremental  every 2 hours at :15 UTC   replaces yesterday and today (IST), checks
--                                                          yesterday, refreshes profiles once a day
--   mixpanel-sync-weekly       Sundays 21:45 UTC          replaces the last 14 IST days
--                              (Monday 03:15 IST, between two incremental runs)

do $$
declare
  command_template text := $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'jira_sync_project_url') || '/functions/v1/mixpanel-sync',
      body := '{"mode":"%s"}'::jsonb,
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-mixpanel-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mixpanel_sync_auth_secret')
      ),
      timeout_milliseconds := 150000
    );
  $cmd$;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mixpanel-sync-incremental') then
    perform cron.schedule('mixpanel-sync-incremental', '15 */2 * * *', format(command_template, 'incremental'));
  end if;
  if not exists (select 1 from cron.job where jobname = 'mixpanel-sync-weekly') then
    perform cron.schedule('mixpanel-sync-weekly', '45 21 * * 0', format(command_template, 'weekly'));
  end if;
end $$;

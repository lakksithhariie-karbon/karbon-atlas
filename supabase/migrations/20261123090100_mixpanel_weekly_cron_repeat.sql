-- The weekly refresh (last 14 IST days) does not fit one 150-second Edge Function call. Fire it every
-- 15 minutes from 21:00 to 23:45 UTC on Sundays (02:30 to 05:15 IST Monday); each call replaces the
-- days not replaced in the last 6 hours, so the first calls do the work and the rest return at once.

do $$
declare
  weekly bigint := (select jobid from cron.job where jobname = 'mixpanel-sync-weekly');
begin
  if weekly is null then
    raise exception 'mixpanel-sync-weekly is not scheduled; apply 20261122140000_mixpanel_sync_cron.sql first';
  end if;
  perform cron.alter_job(job_id := weekly, schedule := '*/15 21-23 * * 0');
end $$;

-- Private Storage bucket for the cleaned Mixpanel archive: one gzipped JSONL file per IST day,
-- holding allowlisted fields only (no personal data). Used to rebuild f02_product without
-- calling Mixpanel, and to keep history past Mixpanel's 730-day retention.
--
-- Private: public = false, and no storage.objects policy grants anon or authenticated anything on
-- this bucket, so only the service role (the sync function) can read or write it. The Data Layer
-- login has no access to the storage schema.
--
-- Safe to run twice; a re-run forces the bucket back to private.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mixpanel-archive', 'mixpanel-archive', false, 52428800, array['application/gzip'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

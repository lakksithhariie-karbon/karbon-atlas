-- Schema for the Product function's data (first source: Mixpanel project Korefi Prod).
--
-- Naming: f<NN>_<function>, like f01_engineering. The Data Layer lists any f<NN>_ schema its login
-- can use, so granting read access (a later migration) is all it takes to make this readable.
-- Access: no grants to anon or authenticated. The schema is not exposed through the Data API.

create schema if not exists f02_product;

comment on schema f02_product is
  'Product usage data from Mixpanel (Korefi Prod), from 2026-01-01 IST. Days are India time (Asia/Kolkata). No personal data: no emails, phones, person names, GSTINs or file names.';

revoke all on schema f02_product from public, anon, authenticated;
alter default privileges in schema f02_product revoke all on tables from public, anon, authenticated;
alter default privileges in schema f02_product revoke all on sequences from public, anon, authenticated;
alter default privileges in schema f02_product revoke all on functions from public, anon, authenticated;

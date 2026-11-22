-- Karbon-only. Read access to f02_product for the Data Layer login, the same way as f01_engineering
-- (see 20261119200000_data_layer_reader.sql).
--
--   ro_f02_product      Group role (no login) holding read access to f02_product.
--   karbon_data_reader  Inherits ro_f02_product's privileges; cannot SET ROLE to it.
--
-- The Data Layer lists every f<NN>_ schema its login can use, so no gatekeeper change is needed.
-- karbon_data_reader's search_path stays pg_catalog, f01_engineering: f02_product names are
-- always schema-qualified, so tables in the two schemas can never shadow each other.
--
-- Safe to run twice.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ro_f02_product') then
    create role ro_f02_product nologin;
  end if;
end
$$;

alter role ro_f02_product nologin nocreatedb nocreaterole;

grant ro_f02_product to karbon_data_reader with inherit true, set false, admin false;

grant usage on schema f02_product to ro_f02_product;
grant select on all tables in schema f02_product to ro_f02_product;
alter default privileges for role postgres in schema f02_product
  grant select on tables to ro_f02_product;
-- f02_product has no functions. supabase/tests/data_layer_reader_test.ts fails if one becomes
-- executable by the Data Layer login.

comment on role ro_f02_product is
  'Karbon Data Layer: read access to f02_product (tables and views). No login.';

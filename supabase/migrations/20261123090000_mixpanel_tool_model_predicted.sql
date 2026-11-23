-- Two Mixpanel properties the first load dropped as unknown, now kept (owner's decision, 2026-11-23):
--   Download.tool                     the accounting tool a download was for
--   Txn Category Updated.modelPredicted  whether the category shown was the AI's suggestion
-- (Product Subscription.companyUuid needs no column: it fills company_id when companyId is absent.)

alter table f02_product.mp_event_daily_facts add column if not exists tool text;
alter table f02_product.mp_event_daily_facts add column if not exists model_predicted boolean;

comment on column f02_product.mp_event_daily_facts.tool is 'Download only: the accounting tool the file was made for, e.g. Tally. Set from transform version 2.';
comment on column f02_product.mp_event_daily_facts.model_predicted is 'Txn Category Updated only: true when the category was the AI''s suggestion. Set from transform version 2.';

update ingest.mixpanel_unknown_fields
set decision = 'allowed'
where (event_name, field_name) in (
  ('Download', 'tool'), ('Product Subscription', 'companyUuid'), ('Txn Category Updated', 'modelPredicted')
);

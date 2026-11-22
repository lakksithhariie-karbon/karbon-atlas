-- f02_product tables for Mixpanel (Korefi Prod), from 2026-01-01 IST.
--
-- Design (agreed 2026-11-22):
--   * Daily totals, not one row per event, except the small inbox family (mp_inbox_events).
--   * Every day is an IST (Asia/Kolkata) day, matching Mixpanel's own reports.
--   * Raw dimensions are stored as Mixpanel sends them. Business rules (modules, "active", dead
--     events, auto-landing dashboard views) live in mp_area_map and in views, so changing a
--     definition never needs a reload.
--   * Staff status is per user (mp_users.is_internal), joined in views, so a rule change never
--     rewrites facts. Staff events are kept, so totals match Mixpanel.
--   * No personal data: no emails, phones, person names, GSTINs or file names. Fields are allowlisted
--     in the sync code; anything else is dropped before it reaches the database.
--   * The sync replaces a whole IST day in one transaction, so a re-run never double-counts.
--
-- Safe to run twice.

create table if not exists f02_product.mp_events (
  event_name text primary key,
  description text,
  first_seen_on date,
  last_seen_on date,
  auto_added boolean not null default true,
  reviewed_at timestamptz
);

create table if not exists f02_product.mp_event_daily_facts (
  event_date date not null,
  event_name text not null,
  company_id uuid,
  user_id uuid,
  source text,
  type text,
  sub_type text,
  status text,
  action text,
  route text,
  final_route text,
  entity_type text,
  view_source text,
  widget_name text,
  item_status text,
  tool_connected text,
  product_code text,
  method text,
  flow text,
  channel text,
  outcome text,
  stage text,
  reason text,
  file_type text,
  event_count integer not null,
  items_sum bigint,
  first_at timestamptz not null,
  last_at timestamptz not null,
  transform_version smallint not null,
  constraint mp_event_daily_facts_count_check check (event_count > 0),
  constraint mp_event_daily_facts_time_check check (first_at <= last_at)
);

create index if not exists mp_event_daily_facts_date_idx on f02_product.mp_event_daily_facts (event_date);
create index if not exists mp_event_daily_facts_company_idx on f02_product.mp_event_daily_facts (company_id, event_date);
create index if not exists mp_event_daily_facts_user_idx on f02_product.mp_event_daily_facts (user_id, event_date);

create table if not exists f02_product.mp_inbox_events (
  insert_id text primary key,
  event_date date not null,
  event_at timestamptz not null,
  event_name text not null,
  item_id uuid,
  company_id uuid,
  org_id uuid,
  user_id uuid,
  source text,
  item_status text,
  route text,
  final_route text,
  previous_route text,
  new_route text,
  transform_version smallint not null
);

create index if not exists mp_inbox_events_date_idx on f02_product.mp_inbox_events (event_date);
create index if not exists mp_inbox_events_item_idx on f02_product.mp_inbox_events (item_id, event_at);

create table if not exists f02_product.mp_users (
  user_id uuid primary key,
  is_internal boolean not null default false,
  internal_rule_version smallint,
  sign_up_date date,
  sign_up_method text,
  user_role text,
  first_seen_on date,
  last_seen_on date,
  profile_synced_at timestamptz
);

create table if not exists f02_product.mp_companies (
  company_id uuid primary key,
  company_name text,
  organisation_id text,
  tool_connected text,
  first_seen_on date,
  last_seen_on date,
  profile_synced_at timestamptz
);

create table if not exists f02_product.mp_area_map (
  dimension text not null,
  value text not null,
  module text not null,
  priority smallint not null default 100,
  note text,
  primary key (dimension, value),
  constraint mp_area_map_dimension_check check (dimension in
    ('event_name', 'route', 'final_route', 'type', 'entity_type', 'widget_name', 'product_code', 'source'))
);

-- Draft module map from the 2026-11-21 inventory. Reviewed with the owner when the metric views are
-- built (Phase 3). Lower priority wins when one event matches several rows.
insert into f02_product.mp_area_map (dimension, value, module, priority, note) values
  ('route', 'ap', 'AP', 10, 'Inbox route'),
  ('route', 'ar', 'AR', 10, 'Inbox route'),
  ('route', 'jv', 'JV', 10, 'Inbox route (journal voucher)'),
  ('final_route', 'ap', 'AP', 10, 'Inbox route after approval'),
  ('final_route', 'ar', 'AR', 10, 'Inbox route after approval'),
  ('final_route', 'jv', 'JV', 10, 'Inbox route after approval'),
  ('entity_type', 'bill', 'AP', 20, null),
  ('entity_type', 'invoice', 'AR', 20, null),
  ('entity_type', 'journal_voucher', 'JV', 20, null),
  ('type', 'bill', 'AP', 30, 'Upload type'),
  ('type', 'invoice', 'AR', 30, 'Upload and Download type'),
  ('type', 'statement', 'Banking', 30, 'Upload and Download type'),
  ('type', 'Payment', 'Banking', 30, 'Bank transaction type'),
  ('type', 'Receipt', 'Banking', 30, 'Bank transaction type'),
  ('type', 'Contra', 'Banking', 30, 'Bank transaction type'),
  ('type', 'purchase_register', 'GST Recon', 30, 'Upload type'),
  ('type', 'gstr2b', 'GST Recon', 30, 'Upload type'),
  ('type', 'gst_reconciliation', 'GST Recon', 30, 'Export type'),
  ('type', 'Tally', 'Tally Sync/Integration', 30, null),
  ('product_code', 'gstr', 'GST Recon', 40, 'Product Subscription'),
  ('product_code', 'aia', 'Billing', 40, 'Product Subscription'),
  ('widget_name', 'ap_outstanding', 'AP', 50, 'Dashboard widget'),
  ('widget_name', 'ap_aging', 'AP', 50, 'Dashboard widget'),
  ('widget_name', 'top_vendors', 'AP', 50, 'Dashboard widget'),
  ('widget_name', 'upcoming_payments', 'AP', 50, 'Dashboard widget'),
  ('widget_name', 'ar_outstanding', 'AR', 50, 'Dashboard widget'),
  ('widget_name', 'ar_aging', 'AR', 50, 'Dashboard widget'),
  ('widget_name', 'top_customers_by_revenue', 'AR', 50, 'Dashboard widget'),
  ('event_name', 'Accounting Sync', 'Tally Sync/Integration', 60, null),
  ('event_name', 'Integration status', 'Tally Sync/Integration', 60, null),
  ('event_name', 'Recon Processed', 'GST Recon', 60, null),
  ('event_name', 'Transaction Ledger Updated', 'Banking', 60, null),
  ('event_name', 'Transaction Status', 'Banking', 60, null),
  ('event_name', 'Transaction Type Updated', 'Banking', 60, null),
  ('event_name', 'Transaction Configuration Edited', 'Banking', 60, null),
  ('event_name', 'Vendor Mismatch Resolved', 'AP', 60, null),
  ('event_name', 'Invoice Bulk Edited', 'AR', 60, null),
  ('event_name', 'Invoice Created', 'AR', 60, null),
  ('event_name', 'Inbox Document Received', 'Inbox', 60, null),
  ('event_name', 'Inbox Item Viewed', 'Inbox', 60, null),
  ('event_name', 'Inbox Item Approved', 'Inbox', 60, null),
  ('event_name', 'Inbox Item Deleted', 'Inbox', 60, null),
  ('event_name', 'Inbox AI Route Overridden', 'Inbox', 60, null),
  ('event_name', 'Product Subscription', 'Billing', 60, null),
  ('event_name', 'Billing Intent Created', 'Billing', 60, null),
  ('event_name', 'Billing Intent Reserved', 'Billing', 60, null),
  ('event_name', 'Billing Intent Claimed', 'Billing', 60, null),
  ('event_name', 'Billing Intent Refreshed', 'Billing', 60, null),
  ('event_name', 'Billing Intent Failed', 'Billing', 60, null),
  ('event_name', 'Billing Intent Recovered', 'Billing', 60, null)
on conflict (dimension, value) do nothing;

-- Comments are what the Karbon Atlas agent reads through describeTable, so they say what each column
-- means and how to use it.
comment on table f02_product.mp_events is
  'Catalog of Mixpanel event names seen since 2026-01-01. New names are added automatically (auto_added = true) until reviewed.';
comment on column f02_product.mp_events.event_name is 'Event name exactly as Mixpanel records it (case-sensitive, e.g. Login and logout).';
comment on column f02_product.mp_events.description is 'What the event means, in plain words.';
comment on column f02_product.mp_events.first_seen_on is 'First IST day with this event since 2026-01-01.';
comment on column f02_product.mp_events.last_seen_on is 'Latest IST day with this event. An old date means the event stopped firing.';
comment on column f02_product.mp_events.auto_added is 'True when the sync added the name and nobody has reviewed it yet.';
comment on column f02_product.mp_events.reviewed_at is 'When the name was reviewed and mapped.';

comment on table f02_product.mp_event_daily_facts is
  'Event counts per IST day, event, company, user and raw dimensions. One row combines identical events of one user in one company on one day. Sum event_count; never count rows. Includes staff traffic: join mp_users and filter is_internal = false for customer usage.';
comment on column f02_product.mp_event_daily_facts.event_date is 'IST day (Asia/Kolkata) of the events.';
comment on column f02_product.mp_event_daily_facts.event_name is 'Mixpanel event name. See mp_events.';
comment on column f02_product.mp_event_daily_facts.company_id is 'Company (tenant) id, Mixpanel companyId. Null on about 4% of events. Join mp_companies for the name.';
comment on column f02_product.mp_event_daily_facts.user_id is 'User id (Mixpanel $user_id). Join mp_users for staff status and sign-up date.';
comment on column f02_product.mp_event_daily_facts.source is 'Where the action came from, e.g. drawer, inline, bulk, whatsapp, upload.';
comment on column f02_product.mp_event_daily_facts.type is 'Event type property, e.g. bill, statement, invoice, purchase_register, gstr2b, single, bulk, Payment, Receipt.';
comment on column f02_product.mp_event_daily_facts.sub_type is 'Event subType, e.g. bulk, needs_review, bank names on statement uploads.';
comment on column f02_product.mp_event_daily_facts.status is 'Outcome status, e.g. Success, Failed, Accounting Ready, Pending.';
comment on column f02_product.mp_event_daily_facts.action is 'Action taken, e.g. Save & Mark as Accounting Ready.';
comment on column f02_product.mp_event_daily_facts.route is 'Inbox route the AI selected: ap, ar or jv.';
comment on column f02_product.mp_event_daily_facts.final_route is 'Inbox route when the item was approved: ap, ar or jv.';
comment on column f02_product.mp_event_daily_facts.entity_type is 'Entity created: bill, invoice, stock_item, journal_voucher.';
comment on column f02_product.mp_event_daily_facts.view_source is 'Dashboard Viewed only: auto_landing (opened automatically) or tab_click (chosen by the user).';
comment on column f02_product.mp_event_daily_facts.widget_name is 'Widget Clicked only: dashboard widget name.';
comment on column f02_product.mp_event_daily_facts.item_status is 'Inbox item status at the event, e.g. needs_review, approved, duplicate.';
comment on column f02_product.mp_event_daily_facts.tool_connected is 'Accounting system connected: tally (Zoho is rare).';
comment on column f02_product.mp_event_daily_facts.product_code is 'Product Subscription only: aia or gstr.';
comment on column f02_product.mp_event_daily_facts.method is 'Login or sign-up method: CREDENTIALS, GOOGLE, MICROSOFT.';
comment on column f02_product.mp_event_daily_facts.flow is 'LOGIN or SIGNUP.';
comment on column f02_product.mp_event_daily_facts.channel is 'Invite channel, e.g. whatsapp.';
comment on column f02_product.mp_event_daily_facts.outcome is 'Phone verification and billing intent outcome, e.g. COMPLETED, FAILED, CLAIMED.';
comment on column f02_product.mp_event_daily_facts.stage is 'Phone verification and billing intent stage.';
comment on column f02_product.mp_event_daily_facts.reason is 'Failure reason, e.g. INVALID_CHALLENGE, DUPLICATE_PHONE.';
comment on column f02_product.mp_event_daily_facts.file_type is 'Uploaded file type, e.g. application/pdf, image/jpeg.';
comment on column f02_product.mp_event_daily_facts.event_count is 'Number of events this row stands for. Always sum it.';
comment on column f02_product.mp_event_daily_facts.items_sum is 'Sum of the item counts the events carry (itemsCount, items_count, transactionCount). Null when none do.';
comment on column f02_product.mp_event_daily_facts.first_at is 'Time of the first of these events that day.';
comment on column f02_product.mp_event_daily_facts.last_at is 'Time of the last of these events that day.';
comment on column f02_product.mp_event_daily_facts.transform_version is 'Cleaning code version that built this row.';

comment on table f02_product.mp_inbox_events is
  'One row per Inbox event (Document Received, Item Viewed, Item Approved, Item Deleted, AI Route Overridden), for per-item metrics such as the AI routing override rate. Inbox tracking started in October 2026.';
comment on column f02_product.mp_inbox_events.insert_id is 'Mixpanel $insert_id, unique per event.';
comment on column f02_product.mp_inbox_events.event_date is 'IST day of the event.';
comment on column f02_product.mp_inbox_events.event_at is 'Event time.';
comment on column f02_product.mp_inbox_events.event_name is 'Inbox event name.';
comment on column f02_product.mp_inbox_events.item_id is 'Inbox item id. Group by it for per-item metrics.';
comment on column f02_product.mp_inbox_events.company_id is 'Company id.';
comment on column f02_product.mp_inbox_events.org_id is 'Organisation id the item belongs to.';
comment on column f02_product.mp_inbox_events.user_id is 'User id.';
comment on column f02_product.mp_inbox_events.source is 'How the document arrived: whatsapp or upload.';
comment on column f02_product.mp_inbox_events.item_status is 'Item status at the event.';
comment on column f02_product.mp_inbox_events.route is 'Route selected when viewed: ap, ar or jv.';
comment on column f02_product.mp_inbox_events.final_route is 'Route on approval: ap, ar or jv.';
comment on column f02_product.mp_inbox_events.previous_route is 'AI Route Overridden only: the route the AI chose.';
comment on column f02_product.mp_inbox_events.new_route is 'AI Route Overridden only: the route the user changed it to.';
comment on column f02_product.mp_inbox_events.transform_version is 'Cleaning code version that built this row.';

comment on table f02_product.mp_users is
  'One row per user seen since 2026-01-01, with staff status and sign-up details. No email, name or phone is stored.';
comment on column f02_product.mp_users.user_id is 'User id (Mixpanel $user_id).';
comment on column f02_product.mp_users.is_internal is 'True for Karbon or Korefi staff (the "Real users" cohort rule). Exclude them for customer metrics.';
comment on column f02_product.mp_users.internal_rule_version is 'Version of the staff rule that set is_internal.';
comment on column f02_product.mp_users.sign_up_date is 'Sign-up date from the Mixpanel profile. Use it for new-user and cohort questions: data starts 2026-01-01, so first_seen_on alone would make 2025 users look new.';
comment on column f02_product.mp_users.sign_up_method is 'CREDENTIALS, GOOGLE, MICROSOFT or invite.';
comment on column f02_product.mp_users.user_role is 'Role from the profile, e.g. accountant. Often empty.';
comment on column f02_product.mp_users.first_seen_on is 'First IST day with an event from this user since 2026-01-01.';
comment on column f02_product.mp_users.last_seen_on is 'Latest IST day with an event from this user.';
comment on column f02_product.mp_users.profile_synced_at is 'When the profile fields were last refreshed from Mixpanel.';

comment on table f02_product.mp_companies is
  'One row per company (tenant) seen in Mixpanel, with its business name.';
comment on column f02_product.mp_companies.company_id is 'Company id (Mixpanel companyId / group key company).';
comment on column f02_product.mp_companies.company_name is 'Business name from the Mixpanel company profile.';
comment on column f02_product.mp_companies.organisation_id is 'Organisation the company belongs to, where set (a minority of companies).';
comment on column f02_product.mp_companies.tool_connected is 'Accounting system last seen for this company: tally or zoho.';
comment on column f02_product.mp_companies.first_seen_on is 'First IST day with an event for this company since 2026-01-01.';
comment on column f02_product.mp_companies.last_seen_on is 'Latest IST day with an event for this company.';
comment on column f02_product.mp_companies.profile_synced_at is 'When the profile fields were last refreshed from Mixpanel.';

comment on table f02_product.mp_area_map is
  'Maps raw dimension values to product modules (AP, AR, Banking, GST Recon, Tally Sync/Integration, Inbox, JV, Billing). When one event matches several rows, the lowest priority wins.';
comment on column f02_product.mp_area_map.dimension is 'Which column of mp_event_daily_facts the value is matched against.';
comment on column f02_product.mp_area_map.value is 'Exact value in that column.';
comment on column f02_product.mp_area_map.module is 'Product module the value belongs to.';
comment on column f02_product.mp_area_map.priority is 'Lower wins when several rows match one event.';
comment on column f02_product.mp_area_map.note is 'Where the value appears.';

create or replace view f02_product.data_freshness as
select
  'mixpanel'::text as source,
  (select max(event_date) from ingest.mixpanel_day_state) as latest_day,
  (select max(finished_at) from ingest.mixpanel_sync_runs where mode = 'incremental' and status = 'ok') as last_successful_sync_at,
  (select max(profile_synced_at) from f02_product.mp_users) as profiles_synced_at,
  (select days_failing_check_30d from ingest.mixpanel_sync_health where mode = 'incremental') as days_failing_check_30d,
  (select coalesce(bool_or(is_stale), true) from ingest.mixpanel_sync_health) as is_stale;

comment on view f02_product.data_freshness is
  'When the Mixpanel data was last synced. Quote last_successful_sync_at in answers. Reads the private sync log on the reader''s behalf.';
comment on column f02_product.data_freshness.source is 'Data source name.';
comment on column f02_product.data_freshness.latest_day is 'Latest IST day loaded. Today is partial until the day ends.';
comment on column f02_product.data_freshness.last_successful_sync_at is 'When the last successful 2-hour sync finished.';
comment on column f02_product.data_freshness.profiles_synced_at is 'When user profiles (staff status, sign-up dates) were last refreshed.';
comment on column f02_product.data_freshness.days_failing_check_30d is 'Days in the last 30 whose totals did not match Mixpanel. Should be 0.';
comment on column f02_product.data_freshness.is_stale is 'True when the 2-hour sync is more than 6 hours late or the weekly check more than 8 days late.';

revoke all on all tables in schema f02_product from public, anon, authenticated;

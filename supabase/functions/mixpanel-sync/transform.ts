/**
 * Cleaning rules for Mixpanel events. Pure functions only (no network, no database), shared by the
 * Edge Function and the local backfill so both build identical rows.
 *
 * Privacy model: an allowlist. Only the properties named in ID_FIELDS, DIMENSIONS, ITEM_COUNT_FIELDS
 * and ARCHIVE_FIELDS leave this module. Every other property is dropped; names that are not in
 * KNOWN_DROPPED are reported (name only, never the value) so a person can review them. Emails are read
 * only to decide staff status and are never returned.
 */

import { STAFF_RULE_VERSION, TRANSFORM_VERSION } from "./version.ts";

export interface MixpanelEvent {
  event: string;
  properties: Record<string, unknown>;
}

/** An event after cleaning: what the archive stores and the rest of the pipeline reads. */
export interface CleanEvent {
  event: string;
  insert_id: string;
  time: number;
  user_id: string | null;
  company_id: string | null;
  props: Record<string, string | number | boolean>;
}

export interface FactRow {
  event_date: string;
  event_name: string;
  company_id: string | null;
  user_id: string | null;
  dims: Record<DimensionColumn, string | null>;
  event_count: number;
  items_sum: number | null;
  first_at: string;
  last_at: string;
}

export interface InboxRow {
  insert_id: string;
  event_date: string;
  event_at: string;
  event_name: string;
  item_id: string | null;
  company_id: string | null;
  org_id: string | null;
  user_id: string | null;
  source: string | null;
  item_status: string | null;
  route: string | null;
  final_route: string | null;
  previous_route: string | null;
  new_route: string | null;
}

/** Counts that describe what cleaning did, for the run log. Names and numbers only. */
export interface CleanStats {
  events_in: number;
  duplicates: number;
  invalid_ids: Record<string, number>;
  redacted_values: Record<string, number>;
  unknown_fields: Record<string, number>;
}

export const IST_OFFSET_SECONDS = 19_800;

/** Staff rule from the "Real users (w/o Karbon employees)" cohort: email contains any of these. */
export const STAFF_EMAIL_SUBSTRINGS = ["karbon", "korefi", "aiaccountant.com"] as const;

/** Raw property → facts column. Values are short enums; anything PII-shaped is redacted. */
export const DIMENSIONS = {
  source: "source",
  type: "type",
  subType: "sub_type",
  status: "status",
  action: "action",
  selectedRoute: "route",
  finalRoute: "final_route",
  entityType: "entity_type",
  viewSource: "view_source",
  widgetName: "widget_name",
  itemStatus: "item_status",
  toolConnected: "tool_connected",
  productCode: "product_code",
  method: "method",
  flow: "flow",
  channel: "channel",
  outcome: "outcome",
  stage: "stage",
  reason: "reason",
  fileType: "file_type",
  tool: "tool",
  modelPredicted: "model_predicted",
} as const;
export type DimensionColumn = (typeof DIMENSIONS)[keyof typeof DIMENSIONS];
export const DIMENSION_COLUMNS = Object.values(DIMENSIONS) as DimensionColumn[];

/** Properties that must be UUIDs. Anything else becomes null and is counted. */
export const ID_FIELDS = [
  "companyId", "company", "ucUuid", "orgId", "itemId", "fromCompanyId", "toCompanyId", "bankLineUuid",
  "productUuid", "invitationUuid", "companyUuid",
] as const;

/** Properties that name the event's company, in order of preference. Carried as company_id. */
const COMPANY_FIELDS = ["companyId", "company", "companyUuid"] as const;

export const ITEM_COUNT_FIELDS = ["itemsCount", "items_count", "transactionCount"] as const;

/** Other harmless properties kept in the archive (enums, flags, dates, numbers). */
export const ARCHIVE_FIELDS = [
  "previousRoute", "newRoute", "from", "to", "transactionType", "isReactivation", "billingExpected", "signUpDate",
  "signUpMethod", "attemptsRemaining", "pageName", "resolutionType", "periodFrom", "periodTo", "configField",
  "newState", "previousState", "templateType", "fileSizeKb", "verificationMethod", "organisationId",
  "mp_processing_time_ms",
] as const;

/**
 * Properties dropped on purpose: personal data, Mixpanel transport fields, and duplicates of a kept id.
 * They are not reported as unknown.
 */
export const KNOWN_DROPPED = new Set<string>([
  "email", "companyName", "fromCompanyName", "toCompanyName", "createdBy", "gstin", "fileName",
  "distinct_id", "$user_id", "userId", "userUuid", "$insert_id", "time", "timestamp", "sync_items",
  "mp_lib", "$lib_version", "$mp_api_endpoint", "$mp_api_timestamp_ms", "$mp_event_size",
  "$mp_raw_user_agent", "$mp_actor_type", "$device_id", "$ip", "$city", "$region", "mp_country_code",
]);

const KEPT = new Set<string>([...Object.keys(DIMENSIONS), ...ID_FIELDS, ...ITEM_COUNT_FIELDS, ...ARCHIVE_FIELDS]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[^@\s]+@[^@\s]+\.[a-z]{2,}/i;
const PHONE = /(?<![\w-])(\+?91[ -]?)?[6-9]\d{9}(?![\w-])/;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
const MAX_TEXT = 120;

export const INBOX_EVENTS = new Set<string>([
  "Inbox Document Received", "Inbox Item Viewed", "Inbox Item Approved", "Inbox Item Deleted",
  "Inbox AI Route Overridden",
]);

export function emptyStats(): CleanStats {
  return { events_in: 0, duplicates: 0, invalid_ids: {}, redacted_values: {}, unknown_fields: {} };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

/** The IST calendar day (YYYY-MM-DD) of a unix time in seconds. */
export function istDay(unixSeconds: number): string {
  return new Date((unixSeconds + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** A UUID in lower case, or null. Counts anything that was present but not a UUID. */
function uuidOrNull(value: unknown, field: string, stats: CleanStats): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && UUID.test(value)) return value.toLowerCase();
  bump(stats.invalid_ids, field);
  return null;
}

/** A short text value with anything PII-shaped replaced, or null. */
export function safeText(value: unknown, field: string, stats: CleanStats): string | null {
  if (value === undefined || value === null) return null;
  let text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  if (text === null) return null;
  text = text.trim();
  if (text === "" || text === "undefined" || text === "null") return null;
  if (EMAIL.test(text) || GSTIN.test(text) || (!UUID.test(text) && PHONE.test(text))) {
    bump(stats.redacted_values, field);
    return "[redacted]";
  }
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export function isStaffEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const lower = email.toLowerCase();
  return STAFF_EMAIL_SUBSTRINGS.some((s) => lower.includes(s));
}

export interface CleanResult {
  events: CleanEvent[];
  /** Users whose email matched the staff rule in these events. The email itself is not kept. */
  staffUsers: Set<string>;
  stats: CleanStats;
}

/**
 * Removes duplicates by $insert_id (keeping the copy Mixpanel processed first), applies the allowlist,
 * validates ids and redacts PII-shaped text. Events without $insert_id or time are dropped and counted.
 */
export function cleanEvents(raw: Iterable<MixpanelEvent>, stats: CleanStats = emptyStats()): CleanResult {
  const chosen = new Map<string, MixpanelEvent>();
  for (const e of raw) {
    stats.events_in += 1;
    const p = e?.properties ?? {};
    const id = p["$insert_id"];
    if (typeof id !== "string" || id === "" || typeof p["time"] !== "number" || typeof e.event !== "string") {
      bump(stats.invalid_ids, "$insert_id_or_time");
      continue;
    }
    const previous = chosen.get(id);
    if (previous) {
      stats.duplicates += 1;
      const a = Number(previous.properties["mp_processing_time_ms"] ?? Infinity);
      const b = Number(p["mp_processing_time_ms"] ?? Infinity);
      if (b < a) chosen.set(id, e);
      continue;
    }
    chosen.set(id, e);
  }

  const events: CleanEvent[] = [];
  const staffUsers = new Set<string>();
  for (const [insertId, e] of chosen) {
    const p = e.properties;
    const user = uuidOrNull(p["$user_id"] ?? p["distinct_id"] ?? p["userId"], "user_id", stats);
    const companyRaw = COMPANY_FIELDS.map((f) => p[f]).find((v) => v !== undefined && v !== null && v !== "");
    const company = uuidOrNull(companyRaw, "company_id", stats);
    if (user && isStaffEmail(p["email"])) staffUsers.add(user);

    const props: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(p)) {
      if (!KEPT.has(key)) {
        if (!KNOWN_DROPPED.has(key)) bump(stats.unknown_fields, `${e.event}\u0000${key}`);
        continue;
      }
      if ((COMPANY_FIELDS as readonly string[]).includes(key)) continue; // carried as company_id
      if ((ID_FIELDS as readonly string[]).includes(key)) {
        const id = uuidOrNull(value, key, stats);
        if (id) props[key] = id;
      } else if ((ITEM_COUNT_FIELDS as readonly string[]).includes(key) || key === "mp_processing_time_ms" ||
        key === "attemptsRemaining" || key === "fileSizeKb") {
        const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
        if (Number.isFinite(n)) props[key] = n;
      } else if (typeof value === "boolean") {
        props[key] = value;
      } else {
        const text = safeText(value, key, stats);
        if (text !== null) props[key] = text;
      }
    }
    events.push({ event: e.event, insert_id: insertId, time: p["time"] as number, user_id: user, company_id: company, props });
  }
  events.sort((a, b) => a.time - b.time || (a.insert_id < b.insert_id ? -1 : 1));
  return { events, staffUsers, stats };
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function dim(e: CleanEvent, key: string): string | null {
  const v = e.props[key];
  return v === undefined ? null : String(v);
}

/** Daily totals for one IST day. One row per distinct (event, company, user, dimensions). */
export function buildFacts(day: string, events: CleanEvent[]): FactRow[] {
  const rows = new Map<string, FactRow>();
  for (const e of events) {
    if (istDay(e.time) !== day) continue;
    const dims = {} as Record<DimensionColumn, string | null>;
    for (const [prop, column] of Object.entries(DIMENSIONS)) dims[column as DimensionColumn] = dim(e, prop);
    const key = JSON.stringify([e.event, e.company_id, e.user_id, ...DIMENSION_COLUMNS.map((c) => dims[c])]);
    let items: number | null = null;
    for (const f of ITEM_COUNT_FIELDS) if (typeof e.props[f] === "number") items = (items ?? 0) + (e.props[f] as number);
    const at = iso(e.time);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        event_date: day, event_name: e.event, company_id: e.company_id, user_id: e.user_id, dims,
        event_count: 1, items_sum: items, first_at: at, last_at: at,
      });
    } else {
      row.event_count += 1;
      if (items !== null) row.items_sum = (row.items_sum ?? 0) + items;
      if (at < row.first_at) row.first_at = at;
      if (at > row.last_at) row.last_at = at;
    }
  }
  return [...rows.values()];
}

export function buildInbox(day: string, events: CleanEvent[]): InboxRow[] {
  const out: InboxRow[] = [];
  for (const e of events) {
    if (!INBOX_EVENTS.has(e.event) || istDay(e.time) !== day) continue;
    out.push({
      insert_id: e.insert_id, event_date: day, event_at: iso(e.time), event_name: e.event,
      item_id: (e.props["itemId"] as string) ?? null, company_id: e.company_id,
      org_id: (e.props["orgId"] as string) ?? null, user_id: e.user_id,
      source: dim(e, "source"), item_status: dim(e, "itemStatus"), route: dim(e, "selectedRoute"),
      final_route: dim(e, "finalRoute"), previous_route: dim(e, "previousRoute"), new_route: dim(e, "newRoute"),
    });
  }
  return out;
}

/** The archive file for one IST day: cleaned events as JSON lines. */
export function archiveLines(day: string, events: CleanEvent[]): string {
  return events.filter((e) => istDay(e.time) === day).map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Reads an archive file back into cleaned events (for a rebuild). */
export function parseArchive(text: string): CleanEvent[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as CleanEvent);
}

/**
 * Runs archived events through the current cleaning rules again, so a rebuild after a rule change
 * (a field removed from the allowlist, a stricter redaction) applies it to history too. The archive
 * holds no emails, so it cannot add staff users; it can only keep or remove what is already there.
 */
export function recleanArchived(events: CleanEvent[], stats: CleanStats = emptyStats()): CleanEvent[] {
  return cleanEvents(events.map((e) => ({
    event: e.event,
    properties: { ...e.props, $insert_id: e.insert_id, time: e.time, $user_id: e.user_id, companyId: e.company_id },
  })), stats).events;
}

/** Latest accounting tool per company in these events (Company Switched carries toolConnected). */
export function toolByCompany(events: CleanEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    const tool = e.props["toolConnected"];
    const company = (e.props["toCompanyId"] as string | undefined) ?? e.company_id;
    if (company && typeof tool === "string") out.set(company, tool.toLowerCase());
  }
  return out;
}

/** Unknown field counts as rows: [event, field, count]. */
export function unknownFieldRows(stats: CleanStats): Array<[string, string, number]> {
  return Object.entries(stats.unknown_fields).map(([k, n]) => {
    const [event, field] = k.split("\u0000");
    return [event, field, n];
  });
}

export const VERSIONS = { transform: TRANSFORM_VERSION, staffRule: STAFF_RULE_VERSION };

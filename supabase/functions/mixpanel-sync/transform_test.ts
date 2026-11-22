import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  archiveLines,
  buildFacts,
  buildInbox,
  cleanEvents,
  istDay,
  type MixpanelEvent,
  parseArchive,
  toolByCompany,
  unknownFieldRows,
} from "./transform.ts";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** 2026-11-20 12:00:00 UTC = 17:30 IST on the 20th. */
const NOON_UTC = Date.UTC(2026, 10, 20, 12) / 1000;

function ev(event: string, id: string, time: number, props: Record<string, unknown> = {}): MixpanelEvent {
  return { event, properties: { $insert_id: id, time, $user_id: U1, distinct_id: U1, companyId: C1, ...props } };
}

Deno.test("IST day boundary is 18:30 UTC", () => {
  assertEquals(istDay(Date.UTC(2026, 10, 20, 18, 29, 59) / 1000), "2026-11-20");
  assertEquals(istDay(Date.UTC(2026, 10, 20, 18, 30, 0) / 1000), "2026-11-21");
  assertEquals(istDay(Date.UTC(2025, 11, 31, 18, 30, 0) / 1000), "2026-01-01");
});

Deno.test("duplicates are removed by $insert_id, keeping the first processed copy", () => {
  const { events, stats } = cleanEvents([
    ev("Upload", "x", NOON_UTC, { mp_processing_time_ms: 2000, status: "Failed" }),
    ev("Upload", "x", NOON_UTC, { mp_processing_time_ms: 1000, status: "Success" }),
    ev("Upload", "x", NOON_UTC, { mp_processing_time_ms: 3000, status: "Failed" }),
  ]);
  assertEquals(events.length, 1);
  assertEquals(stats.duplicates, 2);
  assertEquals(events[0].props.status, "Success");
});

Deno.test("allowlist drops personal data and reports unknown field names only", () => {
  const { events, stats } = cleanEvents([
    ev("Company Created", "a", NOON_UTC, {
      email: "someone@example.com",
      companyName: "Acme Traders",
      gstin: "29ABCDE1234F1Z5",
      fileName: "invoice-march.pdf",
      customerEmail: "buyer@example.com",
      phoneNumber: "9876543210",
      source: "drawer",
    }),
  ]);
  const text = JSON.stringify(events);
  for (const leaked of ["someone@", "buyer@", "Acme", "29ABCDE", "invoice-march", "9876543210"]) {
    assert(!text.includes(leaked), `${leaked} leaked`);
  }
  assertEquals(events[0].props.source, "drawer");
  const unknown = unknownFieldRows(stats).map(([e, f]) => `${e}.${f}`).sort();
  assertEquals(unknown, ["Company Created.customerEmail", "Company Created.phoneNumber"]);
  assert(!JSON.stringify(stats).includes("buyer@"), "stats must hold names, not values");
});

Deno.test("PII-shaped text in allowlisted fields is redacted, UUIDs are not mistaken for phones", () => {
  const { events, stats } = cleanEvents([
    ev("Upload", "a", NOON_UTC, { subType: "call 9876543210", source: "x@y.com", type: "bill", bankLineUuid: "98765432-1098-4765-8432-109876543210" }),
  ]);
  assertEquals(events[0].props.subType, "[redacted]");
  assertEquals(events[0].props.source, "[redacted]");
  assertEquals(events[0].props.type, "bill");
  assertEquals(events[0].props.bankLineUuid, "98765432-1098-4765-8432-109876543210");
  assertEquals(stats.redacted_values, { subType: 1, source: 1 });
});

Deno.test("non-UUID ids become null and are counted, never fail the day", () => {
  const { events, stats } = cleanEvents([
    ev("Upload", "a", NOON_UTC, { companyId: "undefined" }),
    ev("Upload", "b", NOON_UTC, { companyId: "not-a-uuid", $user_id: "legacy-123", itemId: 42 }),
  ]);
  assertEquals(events.map((e) => e.company_id), [null, null]);
  assertEquals(events[1].user_id, null);
  assertEquals(stats.invalid_ids.company_id, 2);
  assertEquals(stats.invalid_ids.user_id, 1);
  assertEquals(stats.invalid_ids.itemId, 1);
});

Deno.test("staff users are detected from email without keeping the email", () => {
  const { events, staffUsers } = cleanEvents([
    ev("Login", "a", NOON_UTC, { email: "dev@karbon.example" }),
    ev("Login", "b", NOON_UTC, { $user_id: U2, distinct_id: U2, email: "owner@customer.example" }),
  ]);
  assertEquals([...staffUsers], [U1]);
  assert(!JSON.stringify(events).includes("@"));
});

Deno.test("facts group identical events, sum counts and keep first and last time", () => {
  const { events } = cleanEvents([
    ev("Transaction Status", "a", NOON_UTC, { itemsCount: 3, type: "bulk", status: "Accounting Ready" }),
    ev("Transaction Status", "b", NOON_UTC + 60, { itemsCount: "2", type: "bulk", status: "Accounting Ready" }),
    ev("Transaction Status", "c", NOON_UTC + 120, { itemsCount: 5, type: "single", status: "Accounting Ready" }),
    ev("Transaction Status", "d", NOON_UTC + 7 * 3600, { itemsCount: 1, type: "bulk", status: "Accounting Ready" }),
  ]);
  const facts = buildFacts("2026-11-20", events);
  assertEquals(facts.length, 2);
  const bulk = facts.find((f) => f.dims.type === "bulk")!;
  assertEquals(bulk.event_count, 2);
  assertEquals(bulk.items_sum, 5);
  assertEquals(bulk.first_at, "2026-11-20T12:00:00.000Z");
  assertEquals(bulk.last_at, "2026-11-20T12:01:00.000Z");
  assertEquals(buildFacts("2026-11-21", events).length, 1, "the 19:00 UTC event belongs to the next IST day");
});

Deno.test("inbox rows carry the AI route and the correction", () => {
  const { events } = cleanEvents([
    ev("Inbox AI Route Overridden", "a", NOON_UTC, { itemId: ITEM, previousRoute: "ap", newRoute: "jv" }),
    ev("Upload", "b", NOON_UTC),
  ]);
  const inbox = buildInbox("2026-11-20", events);
  assertEquals(inbox.length, 1);
  assertEquals([inbox[0].item_id, inbox[0].previous_route, inbox[0].new_route], [ITEM, "ap", "jv"]);
});

Deno.test("archive round-trips and holds only that IST day", () => {
  const { events } = cleanEvents([
    ev("Upload", "a", NOON_UTC, { email: "dev@karbon.example", type: "bill" }),
    ev("Upload", "b", NOON_UTC + 7 * 3600, { type: "bill" }),
  ]);
  const text = archiveLines("2026-11-20", events);
  assert(!text.includes("@"));
  const back = parseArchive(text);
  assertEquals(back.length, 1);
  assertEquals(buildFacts("2026-11-20", back), buildFacts("2026-11-20", events));
});

Deno.test("latest accounting tool per company", () => {
  const { events } = cleanEvents([
    ev("Company Switched", "a", NOON_UTC, { toCompanyId: C1, toolConnected: "Tally" }),
  ]);
  assertEquals(toolByCompany(events).get(C1), "tally");
});

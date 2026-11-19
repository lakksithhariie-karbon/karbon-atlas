import { buildIncrementalJql, formatJqlTimestamp, parseJiraTimestamp } from "./transform.ts";

function assertEqual(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

Deno.test("incremental JQL subtracts 15 minutes and formats the account zone", () => {
  const jql = buildIncrementalJql("2026-11-18T19:04:37.000+0530", "Asia/Calcutta");
  assertEqual(
    jql,
    'project = SPEND AND updated >= "2026-11-18 18:49" ORDER BY updated ASC',
  );
});

Deno.test("the overlap can cross midnight in the account zone", () => {
  const jql = buildIncrementalJql("2026-11-18T00:10:00.000+0530", "Asia/Kolkata");
  assertEqual(
    jql,
    'project = SPEND AND updated >= "2026-11-17 23:55" ORDER BY updated ASC',
  );
});

Deno.test("formatting uses the given time zone rather than UTC", () => {
  const instant = parseJiraTimestamp("2026-01-15T15:00:00.000Z");
  const since = new Date(instant.getTime() - 15 * 60_000);
  assertEqual(formatJqlTimestamp(since, "America/New_York"), "2026-01-15 09:45");
  assertEqual(formatJqlTimestamp(since, "UTC"), "2026-01-15 14:45");
});

Deno.test("midnight stays 00 and not 24", () => {
  assertEqual(formatJqlTimestamp(parseJiraTimestamp("2026-11-18T00:00:00.000+0530"), "Asia/Calcutta"), "2026-11-18 00:00");
});

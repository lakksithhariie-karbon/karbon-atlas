import { decideDeletionGuard } from "./guard.ts";

Deno.test("deletion guard does not trip at exactly 90 percent", () => {
  const decision = decideDeletionGuard(900, 1000);
  if (decision.tripped) throw new Error("exact 90 percent tripped");
  if (!decision.markMissing) throw new Error("exact 90 percent should still mark missing ids");
  if (decision.warning !== null) throw new Error("exact 90 percent should not warn");
});

Deno.test("deletion guard trips when Jira returns fewer than 90 percent of live issues", () => {
  const decision = decideDeletionGuard(899, 1000);
  if (!decision.tripped) throw new Error("899 of 1000 should trip");
  if (decision.markMissing) throw new Error("a tripped guard must not mark missing ids deleted");
  if (decision.warning === null || !decision.warning.startsWith("deletion guard:")) {
    throw new Error("warning text missing");
  }
  if (!decision.warning.includes("899") || !decision.warning.includes("1000")) {
    throw new Error("warning should name both counts");
  }
  if (decision.warning.includes("@")) throw new Error("warning must not contain an email");
});

Deno.test("deletion guard stays quiet when Jira returns at least 90 percent", () => {
  const decision = decideDeletionGuard(901, 1000);
  if (decision.tripped || decision.warning !== null || !decision.markMissing) {
    throw new Error("901 of 1000 should pass");
  }
});

Deno.test("deletion guard does not trip when Supabase has no live issues", () => {
  const decision = decideDeletionGuard(0, 0);
  if (decision.tripped || !decision.markMissing) throw new Error("empty project should pass");
});

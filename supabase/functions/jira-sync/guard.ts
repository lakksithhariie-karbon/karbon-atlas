/**
 * Nightly deletion check.
 * Trip when Jira returns fewer than 90 percent of the live Supabase issues, so a short
 * id list cannot mark the rest of the project deleted. Returned ids are still cleared.
 */

export interface DeletionGuardDecision {
  /** When false, do not set deleted_at on issues missing from the Jira id list. */
  markMissing: boolean;
  tripped: boolean;
  warning: string | null;
}

/** Compare the Jira id count with live issues. Exactly 90 percent does not trip. */
export function decideDeletionGuard(jiraCount: number, liveCount: number): DeletionGuardDecision {
  const jira = Number.isFinite(jiraCount) ? Math.trunc(jiraCount) : 0;
  const live = Number.isFinite(liveCount) ? Math.trunc(liveCount) : 0;
  const tripped = live > 0 && jira * 10 < live * 9;
  if (!tripped) return { markMissing: true, tripped: false, warning: null };
  return {
    markMissing: false,
    tripped: true,
    warning: `deletion guard: jira returned ${jira} ids, supabase has ${live} live issues`,
  };
}

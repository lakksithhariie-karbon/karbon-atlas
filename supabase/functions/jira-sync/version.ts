/**
 * Bump this whenever a cleaning rule changes.
 * Incremental then re-cleans raw issues still stamped with an older version.
 */
// 2: changelog `created` sent as epoch milliseconds now fills jira_issue_changes.changed_at.
export const CURRENT_TRANSFORM_VERSION = 2;

/** Version written on raw rows in the same transaction as their clean rows. */
export function stampForCleanWrite(): number {
  return CURRENT_TRANSFORM_VERSION;
}

/** A raw issue needs another clean pass when its stamp is missing or behind. */
export function isTransformOutdated(stored: number | null): boolean {
  if (stored === null) return true;
  return stored < CURRENT_TRANSFORM_VERSION;
}

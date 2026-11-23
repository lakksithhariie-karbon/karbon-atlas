/**
 * Bump TRANSFORM_VERSION when a cleaning rule changes. Each rebuilt IST day records the version that
 * built it (ingest.mixpanel_day_state.transform_version), and a rebuild from the archive brings older
 * days up to date without calling Mixpanel.
 *
 * Bump STAFF_RULE_VERSION when the staff rule (STAFF_EMAIL_SUBSTRINGS) changes, then rebuild.
 */
export const TRANSFORM_VERSION = 2;
export const STAFF_RULE_VERSION = 1;

/** First IST day the pipeline keeps. */
export const FIRST_DAY = "2026-01-01";

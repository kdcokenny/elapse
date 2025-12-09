/**
 * Centralized configuration constants and helpers.
 * All defaults that appear across multiple files should live here.
 */

// =============================================================================
// Defaults
// =============================================================================

/** Default timezone for reports when TEAM_TIMEZONE is not set */
export const DEFAULT_TIMEZONE = "America/New_York";

/** Default Redis URL when REDIS_URL is not set */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** Default cron schedule for weekly reports (Friday 4pm) */
export const DEFAULT_WEEKLY_SCHEDULE = "0 16 * * 5";

/** Default cron schedule for daily reports (9 AM Mon-Fri) */
export const DEFAULT_DAILY_SCHEDULE = "0 9 * * 1-5";

/** Default report cadence */
export const DEFAULT_REPORT_CADENCE = "weekly";

/** Default HTTP port */
export const DEFAULT_PORT = 3000;

/** Discord webhook timeout in milliseconds */
export const DISCORD_TIMEOUT_MS = 10000;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the configured team timezone.
 * Falls back to DEFAULT_TIMEZONE if TEAM_TIMEZONE env var is not set.
 */
export function getTimezone(): string {
	return process.env.TEAM_TIMEZONE || DEFAULT_TIMEZONE;
}

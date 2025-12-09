/**
 * Weekly data aggregation from Redis.
 * Pure functions for querying and transforming weekly data.
 */

import { DEFAULT_TIMEZONE } from "../config";
import type { WeekBoundary } from "./weekly-types";

/**
 * Get the day of week (0=Sunday, 6=Saturday) for a date in a specific timezone.
 * Uses Intl.DateTimeFormat to correctly handle timezone differences.
 */
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		timeZone: timezone,
	});
	const weekdayStr = formatter.format(date);
	const dayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	// weekdayStr is always one of the keys from Intl.DateTimeFormat
	return dayMap[weekdayStr] ?? 0;
}

/**
 * Get the date string (YYYY-MM-DD) for a date in a specific timezone.
 */
function getDateStringInTimezone(date: Date, timezone: string): string {
	return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

/**
 * Calculate the week boundary based on report day.
 *
 * If running on Monday: returns previous week's Mon-Fri
 * If running on Fri: returns current week's Mon-Fri
 * Otherwise: returns current week's Mon-Fri (best effort)
 *
 * IMPORTANT: Uses the provided timezone to determine day-of-week.
 * This ensures correct week calculation when server TZ differs from team TZ.
 */
export function getWeekBoundary(
	reportDate: Date,
	timezone = DEFAULT_TIMEZONE,
): WeekBoundary {
	// Get day of week in the TARGET timezone (0 = Sunday, 1 = Monday, ..., 5 = Friday)
	const dayOfWeek = getDayOfWeekInTimezone(reportDate, timezone);

	// Get the date string in target timezone to work with
	const reportDateStr = getDateStringInTimezone(reportDate, timezone);

	// Parse the date string to get a "logical" date (midnight in target TZ concept)
	// We'll work with offsets from this logical date
	const parts = reportDateStr.split("-").map(Number);
	const year = parts[0] as number;
	const month = parts[1] as number;
	const day = parts[2] as number;

	let mondayOffset: number;

	if (dayOfWeek === 1) {
		// Monday - report on PREVIOUS week (go back 7 days to previous Monday)
		mondayOffset = -7;
	} else {
		// Any other day - report on CURRENT week
		// daysFromMonday: Sunday=6, Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5
		mondayOffset = dayOfWeek === 0 ? -6 : -(dayOfWeek - 1);
	}

	// Calculate Monday of the target week
	const mondayDate = new Date(year, month - 1, day + mondayOffset);
	const fridayDate = new Date(year, month - 1, day + mondayOffset + 4);

	// Set times (in local timezone of server, but these dates represent the logical week)
	mondayDate.setHours(0, 0, 0, 0);
	fridayDate.setHours(23, 59, 59, 999);

	// Generate date strings for each day (Mon-Fri)
	const dateStrings: string[] = [];
	for (let i = 0; i < 5; i++) {
		const d = new Date(year, month - 1, day + mondayOffset + i);
		// Use ISO format directly since we calculated the correct dates
		dateStrings.push(
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
		);
	}

	return { start: mondayDate, end: fridayDate, dateStrings };
}

/**
 * Calculate blocker age in days from detection timestamp.
 */
export function calculateBlockerAgeDays(detectedAt: string, now: Date): number {
	const detected = new Date(detectedAt);
	const diffMs = now.getTime() - detected.getTime();
	return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

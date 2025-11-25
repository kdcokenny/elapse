/**
 * Pure functions for formatting output messages.
 */

export interface UserSummary {
	user: string;
	narrative: string;
	commitCount: number;
}

/**
 * Format a daily report for Discord.
 */
export function formatDailyReport(
	date: string,
	userSummaries: UserSummary[],
): string {
	if (userSummaries.length === 0) {
		return `# Daily Standup - ${formatDate(date)}\n\nNo activity to report today.`;
	}

	const sections = userSummaries
		.map((summary) => formatUserSection(summary))
		.join("\n\n---\n\n");

	return `# Daily Standup - ${formatDate(date)}\n\n${sections}`;
}

/**
 * Format a single user's section.
 */
function formatUserSection(summary: UserSummary): string {
	return `**${summary.user}**\n${summary.narrative}`;
}

/**
 * Format a date string (YYYY-MM-DD) to a readable format.
 */
export function formatDate(date: string): string {
	const d = new Date(`${date}T00:00:00`);
	return d.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(timezone?: string): string {
	const tz = timezone || process.env.TEAM_TIMEZONE || "America/New_York";

	return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Format a simple message for console/log output.
 */
export function formatLogSummary(
	date: string,
	totalCommits: number,
	totalUsers: number,
): string {
	return `[${date}] Processed ${totalCommits} commits from ${totalUsers} users`;
}

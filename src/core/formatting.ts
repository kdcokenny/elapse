/**
 * Pure functions for formatting output messages.
 */

import type { UserBlockerGroup } from "./blockers";

/**
 * Feature summary for the shipped section (feature-centric format).
 * One PR = One Feature, with human-readable names and impact.
 */
export interface FeatureSummary {
	featureName: string; // AI-generated headline (e.g., "Improved checkout flow")
	impact: string; // Business value subline (e.g., "Fixed payment validation")
	prNumber: number; // For traceability
	authors: string[]; // Contributors
	commitCount: number;
}

export interface BranchSummary {
	branch: string;
	users: string[];
	commitCount: number;
	prTitle?: string;
	prNumber?: number;
	/** Whether this PR had commits today (undefined = unknown, for legacy) */
	hasActivityToday?: boolean;
	/** AI-generated feature name (e.g., "User authentication improvements") */
	featureName?: string;
	/** AI-generated business impact (e.g., "Enhanced login security") */
	impact?: string;
}

export interface ActivityStats {
	prsMerged: number;
	branchesActive: number;
	totalCommits: number;
	blockerCount: number;
}

/**
 * Format a daily report for Discord with feature-centric shipped section.
 * This is the new format that prioritizes features over users.
 */
export function formatFeatureCentricReport(
	date: string,
	blockerGroups: UserBlockerGroup[],
	shipped: FeatureSummary[],
	progress: BranchSummary[],
	stats: ActivityStats,
): string {
	let report = `🚀 **Daily Engineering Summary — ${formatDate(date)}**\n\n`;

	// Check for empty day
	if (
		blockerGroups.length === 0 &&
		shipped.length === 0 &&
		progress.length === 0
	) {
		report += `📭 **No engineering activity recorded today**\n`;
		return report;
	}

	// BLOCKERS SECTION (first - highest priority, grouped by user)
	if (blockerGroups.length > 0) {
		report += `🔴 **BLOCKERS**\n\n`;
		for (const group of blockerGroups) {
			// Show count suffix only for users with 2+ blockers
			const countSuffix =
				group.blockers.length > 1 ? ` (${group.blockers.length} blockers)` : "";
			report += `• ${group.user}${countSuffix}:\n`;

			for (const b of group.blockers) {
				report += `  → ${b.description}\n`;
				const context = b.prTitle || b.branch;
				if (b.prNumber) {
					report += `    PR #${b.prNumber}: ${context}\n`;
				} else {
					report += `    ${context}\n`;
				}
			}
			report += `\n`;
		}
	}

	// SHIPPED SECTION (feature-centric)
	if (shipped.length > 0) {
		report += `🚢 **SHIPPED TODAY**\n\n`;
		for (const f of shipped) {
			const authors = f.authors.join(", ");
			report += `• ${f.featureName}\n`;
			report += `  → ${f.impact}\n`;
			report += `  → PR #${f.prNumber} (${authors})\n`;
			report += `\n`;
		}
	}

	// IN PROGRESS SECTION
	if (progress.length > 0) {
		report += `📍 **IN PROGRESS**\n\n`;
		for (const p of progress) {
			const users = p.users.join(", ");
			// Prefer AI-generated featureName, fallback to prTitle/branch
			const header = p.featureName || p.prTitle || p.branch;
			report += `• ${header}\n`;

			// Show impact if available
			if (p.impact) {
				report += `  → ${p.impact}\n`;
			}

			// Show activity indicator: "awaiting review" if no activity today
			const activityIndicator =
				p.hasActivityToday === false ? " • awaiting review" : "";
			// Compact format: users and PR on single line
			if (p.prNumber) {
				report += `  → ${users} • PR #${p.prNumber}${activityIndicator}\n`;
			} else {
				report += `  → ${users}${activityIndicator}\n`;
			}
			report += `\n`;
		}
	}

	// STATS (handle singular/plural)
	const statParts: string[] = [];
	if (stats.prsMerged > 0) {
		const label = stats.prsMerged === 1 ? "PR merged" : "PRs merged";
		statParts.push(`${stats.prsMerged} ${label}`);
	}
	if (stats.blockerCount > 0) {
		const label = stats.blockerCount === 1 ? "blocker" : "blockers";
		statParts.push(`${stats.blockerCount} ${label}`);
	}
	if (stats.branchesActive > 0) {
		const label =
			stats.branchesActive === 1
				? "feature in progress"
				: "features in progress";
		statParts.push(`${stats.branchesActive} ${label}`);
	}

	if (statParts.length > 0) {
		report += `📊 ${statParts.join(" • ")}\n`;
	}

	return report;
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
 * Format a "no activity" report for days with no engineering activity.
 */
export function formatNoActivityReport(date: string): string {
	return `🚀 **Daily Engineering Summary — ${formatDate(date)}**\n\n📭 **No engineering activity recorded today**\n`;
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(timezone?: string): string {
	const tz = timezone || process.env.TEAM_TIMEZONE || "America/New_York";

	return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

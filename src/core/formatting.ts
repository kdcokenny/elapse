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
	repo: string; // Repository in "owner/repo" format for PR links
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
	/** Repository in "owner/repo" format for PR links */
	repo?: string;
}

export interface ActivityStats {
	prsMerged: number;
	branchesActive: number;
	totalCommits: number;
	blockerCount: number;
	/** Number of stale review requests (3+ days) */
	staleReviewCount: number;
	/** Age of oldest blocker (e.g., "4 days") */
	oldestBlockerAge?: string;
}

/**
 * Stale review entry for the AWAITING REVIEW section.
 */
export interface StaleReviewEntry {
	prNumber: number;
	prTitle: string;
	reviewer: string;
	daysAgo: number;
	repo: string;
}

/**
 * Build a GitHub PR URL from repo and PR number.
 */
function buildPRUrl(repo: string, prNumber: number): string {
	return `https://github.com/${repo}/pull/${prNumber}`;
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
	staleReviews: StaleReviewEntry[],
	stats: ActivityStats,
): string {
	let report = `🚀 **Daily Engineering Summary — ${formatDate(date)}**\n\n`;

	// Check for empty day
	if (
		blockerGroups.length === 0 &&
		shipped.length === 0 &&
		progress.length === 0 &&
		staleReviews.length === 0
	) {
		report += `📭 **No engineering activity recorded today**\n`;
		return report;
	}

	// BLOCKERS SECTION (first - highest priority, grouped by user)
	if (blockerGroups.length > 0) {
		report += `🔴 **BLOCKERS**\n\n`;
		for (const group of blockerGroups) {
			// Show count and oldest age for users with multiple blockers
			let headerSuffix = "";
			if (group.blockerCount > 1) {
				headerSuffix = ` (${group.blockerCount} blockers`;
				if (group.oldestAge) {
					headerSuffix += `, oldest: ${group.oldestAge}`;
				}
				headerSuffix += ")";
			}
			report += `• ${group.user}${headerSuffix}:\n`;

			for (const b of group.blockers) {
				// Include age badge if available
				const ageBadge = b.age ? ` (${b.age})` : "";
				// Include @mentions if present
				const mentionText =
					b.mentionedUsers && b.mentionedUsers.length > 0
						? ` @${b.mentionedUsers.join(", @")}`
						: "";
				report += `  → ${b.description}${mentionText}${ageBadge}\n`;
				const context = b.prTitle || b.branch;
				if (b.prNumber) {
					const prLink = b.repo
						? `[PR #${b.prNumber}](${buildPRUrl(b.repo, b.prNumber)})`
						: `PR #${b.prNumber}`;
					report += `    ${prLink}: ${context}\n`;
				} else {
					report += `    ${context}\n`;
				}
			}
			report += `\n`;
		}
	}

	// AWAITING REVIEW SECTION (stale reviews - 3+ days with no response)
	if (staleReviews.length > 0) {
		report += `⏳ **AWAITING REVIEW** (3+ days, no response)\n\n`;
		for (const sr of staleReviews) {
			const prLink = `[PR #${sr.prNumber}](${buildPRUrl(sr.repo, sr.prNumber)})`;
			const daysLabel = sr.daysAgo === 1 ? "day" : "days";
			report += `• ${prLink}: @${sr.reviewer} requested ${sr.daysAgo} ${daysLabel} ago — ${sr.prTitle}\n`;
		}
		report += `\n`;
	}

	// SHIPPED SECTION (feature-centric)
	if (shipped.length > 0) {
		report += `🚢 **SHIPPED TODAY**\n\n`;
		for (const f of shipped) {
			const authors = f.authors.join(", ");
			const prLink = `[PR #${f.prNumber}](${buildPRUrl(f.repo, f.prNumber)})`;
			report += `• ${f.featureName}\n`;
			report += `  → ${f.impact}\n`;
			report += `  → ${prLink} (${authors})\n`;
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
				const prLink = p.repo
					? `[PR #${p.prNumber}](${buildPRUrl(p.repo, p.prNumber)})`
					: `PR #${p.prNumber}`;
				report += `  → ${users} • ${prLink}${activityIndicator}\n`;
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
		// Include oldest blocker age if available
		const oldestSuffix = stats.oldestBlockerAge
			? ` (oldest: ${stats.oldestBlockerAge})`
			: "";
		statParts.push(`${stats.blockerCount} ${label}${oldestSuffix}`);
	}
	if (stats.staleReviewCount > 0) {
		const label =
			stats.staleReviewCount === 1 ? "stale review" : "stale reviews";
		statParts.push(`${stats.staleReviewCount} ${label}`);
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
function formatDate(date: string): string {
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

/**
 * Pure functions for formatting output messages.
 */

import type { BlockerSummary } from "./blockers";

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
	blockers: BlockerSummary[],
	shipped: FeatureSummary[],
	progress: BranchSummary[],
	stats: ActivityStats,
): string {
	let report = `🚀 **Daily Engineering Summary — ${formatDate(date)}**\n\n`;

	// Check for empty day
	if (blockers.length === 0 && shipped.length === 0 && progress.length === 0) {
		report += `📭 **No engineering activity recorded today**\n`;
		return report;
	}

	// BLOCKERS SECTION (first - highest priority)
	if (blockers.length > 0) {
		report += `🔴 **BLOCKERS**\n\n`;
		for (const b of blockers) {
			// User-first format: person is prominent, blocker description is the lead
			report += `• ${b.user}: ${b.description}\n`;
			// PR context on sub-line
			const context = b.prTitle ? `${b.prTitle} (${b.branch})` : b.branch;
			report += `  → ${context}\n`;
			if (b.prNumber) {
				report += `  → PR #${b.prNumber}\n`;
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
			// Use "PR Title (branch)" format if prTitle available, otherwise just branch
			const header = p.prTitle ? `${p.prTitle} (${p.branch})` : p.branch;
			report += `• ${header}\n`;
			// Compact format: users and PR on single line (no commit counts - they're noise)
			if (p.prNumber) {
				report += `  → ${users} • PR #${p.prNumber}\n`;
			} else {
				report += `  → ${users}\n`;
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
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(timezone?: string): string {
	const tz = timezone || process.env.TEAM_TIMEZONE || "America/New_York";

	return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

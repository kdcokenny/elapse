/**
 * Pure functions for formatting output messages.
 */

import { getTimezone } from "../config";
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
		// Include oldest blocker age if available (omit if "today" - not headline-worthy)
		const oldestSuffix =
			stats.oldestBlockerAge && stats.oldestBlockerAge !== "today"
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
	const tz = timezone || getTimezone();

	return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// =============================================================================
// Weekly Report Formatting
// =============================================================================

import { formatRAGStatus } from "./weekly-status";
import type { RAGStatus, WeeklyStats, WeeklySummary } from "./weekly-types";

/**
 * Format the "Week of" date string.
 * Returns: "February 24, 2025"
 */
function formatWeekOf(date: Date): string {
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * Flags indicating which data was available when generating the report.
 * Only used for CONTENT sections (Next Week).
 * STATUS sections (Blockers, Help Needed) are always shown.
 */
export interface WeeklyDataFlags {
	hasInProgress: boolean;
}

/**
 * Format a weekly report for Discord.
 * Stakeholder-ready output under 500 words.
 *
 * DESIGN: Status sections vs Content sections
 * - BLOCKERS & RISKS: STATUS - always shown (confirms "all clear" or lists issues)
 * - HELP NEEDED: STATUS - always shown (confirms no escalations or lists asks)
 * - CARRYING INTO NEXT WEEK: CONTENT - only shown if in-progress work exists
 *
 * Status sections stay visible so executives can quickly confirm "we checked"
 * rather than wondering if the report is incomplete.
 */
export function formatWeeklyReport(
	weekOf: Date,
	ragStatus: RAGStatus,
	summary: WeeklySummary,
	stats: WeeklyStats,
	dataFlags?: WeeklyDataFlags,
): string {
	const lines: string[] = [];

	// Default to showing next week if no flags provided (backwards compatibility)
	const flags = dataFlags || { hasInProgress: true };

	// Header
	lines.push(
		`📊 **Weekly Engineering Summary — Week of ${formatWeekOf(weekOf)}**`,
	);
	lines.push("");

	// BLUF (Bottom Line Up Front)
	lines.push(`**Status:** ${formatRAGStatus(ragStatus)}`);
	lines.push(`**Top Line:** ${summary.executiveSummary}`);
	lines.push("");
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push("");

	// Shipped section
	if (summary.shippedGroups.length > 0) {
		lines.push("🚢 **SHIPPED THIS WEEK**");
		lines.push("");
		for (const group of summary.shippedGroups) {
			const contributors = group.contributors.join(", ");
			lines.push(`• **${group.theme}** — ${group.summary} (${contributors})`);
		}
		lines.push("");
	}

	// STATUS: Blockers section - always shown, with deterministic fallback
	lines.push("⚠️ **BLOCKERS & RISKS**");
	lines.push("");
	lines.push(`• ${summary.blockersAndRisks ?? "None active"}`);
	lines.push("");

	// STATUS: Help Needed section - always shown, with deterministic fallback
	lines.push("🙋 **HELP NEEDED**");
	lines.push("");
	lines.push(`• ${summary.helpNeeded ?? "None this week"}`);
	lines.push("");

	// CONTENT: Next Week section - only if we had in-progress data
	if (flags.hasInProgress && summary.nextWeek) {
		lines.push("📍 **CARRYING INTO NEXT WEEK**");
		lines.push("");
		lines.push(`• ${summary.nextWeek}`);
		lines.push("");
	}

	// Footer separator
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	// Stats footer
	const statParts: string[] = [];
	statParts.push(`${stats.totalMerged} PRs merged`);
	if (stats.blockersResolved > 0) {
		statParts.push(`${stats.blockersResolved} blockers resolved`);
	}
	if (stats.activeBlockerCount > 0) {
		statParts.push(`${stats.activeBlockerCount} active blockers`);
	}
	if (stats.inProgressCount > 0) {
		statParts.push(`${stats.inProgressCount} in progress`);
	}
	lines.push(statParts.join(" • "));

	return lines.join("\n");
}

/**
 * Format a "no activity" weekly report.
 */
export function formatNoActivityWeeklyReport(weekOf: Date): string {
	return `📊 **Weekly Engineering Summary — Week of ${formatWeekOf(weekOf)}**

**Status:** 🟢 On Track
**Top Line:** A quiet week with no significant engineering activity.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
0 PRs merged
`;
}

// =============================================================================
// Hybrid Thread Formatting (Embeds + Thread Content)
// =============================================================================

import {
	type DiscordEmbed,
	type DiscordEmbedField,
	RAG_COLORS,
	type ReportType,
} from "../discord";

/**
 * Escalation threshold in days.
 * Blockers older than this surface in the main embed.
 */
const ESCALATION_THRESHOLD_DAYS = 5;

/**
 * Keywords that indicate a blocker requires management intervention.
 * These are non-technical dependencies that managers can unblock.
 */
const ESCALATION_KEYWORDS = [
	"waiting for",
	"need approval",
	"blocked by",
	"finance",
	"legal",
	"vendor",
	"external",
	"procurement",
	"compliance",
	"security review",
];

/**
 * Parse age string to number of days.
 * Returns null if age is undefined or unparseable.
 */
function parseAgeDays(age: string | undefined): number | null {
	if (!age) return null;
	if (age === "today") return 0;
	const match = age.match(/(\d+)\s*days?/);
	return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/**
 * Maximum description length for embed (chars).
 * Keep under 400 for BLUF scannability.
 */
const MAX_EMBED_DESCRIPTION_LENGTH = 380;

/**
 * Escalation info for surfacing in main embed.
 */
export interface EscalationInfo {
	description: string;
	owner: string;
	ageDays: number;
	prNumber?: number;
}

/**
 * Data required for formatting daily hybrid reports.
 */
export interface DailyHybridData {
	date: string;
	blockerGroups: UserBlockerGroup[];
	shipped: FeatureSummary[];
	progress: BranchSummary[];
	staleReviews: StaleReviewEntry[];
	stats: ActivityStats;
}

/**
 * Data required for formatting weekly hybrid reports.
 */
export interface WeeklyHybridData {
	weekOf: Date;
	ragStatus: RAGStatus;
	summary: WeeklySummary;
	stats: WeeklyStats;
	/** Active blockers with age info for escalation detection */
	activeBlockers?: Array<{
		description: string;
		owner: string;
		ageDays: number;
		prNumber?: number;
	}>;
}

/**
 * Format a short date for embed title.
 * Returns: "Dec 16"
 */
function formatShortDate(date: string): string {
	const d = new Date(`${date}T00:00:00`);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Format week start date for embed title.
 * Returns: "Dec 16"
 */
function formatShortWeekOf(date: Date): string {
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Determine RAG color for daily reports based on blockers and stale reviews.
 */
function getDailyRAGColor(stats: ActivityStats): number {
	// Red: any blocker > 5 days (check oldestBlockerAge)
	if (stats.oldestBlockerAge) {
		const match = stats.oldestBlockerAge.match(/(\d+)\s*days?/);
		const daysStr = match?.[1];
		if (daysStr) {
			const days = parseInt(daysStr, 10);
			if (days >= ESCALATION_THRESHOLD_DAYS) {
				return RAG_COLORS.red;
			}
		}
	}

	// Yellow: any blockers or stale reviews
	if (stats.blockerCount > 0 || stats.staleReviewCount > 0) {
		return RAG_COLORS.yellow;
	}

	// Green: all clear
	return RAG_COLORS.green;
}

/**
 * Get RAG color from status string.
 */
function getWeeklyRAGColor(status: RAGStatus): number {
	return RAG_COLORS[status];
}

/**
 * Help Needed item for the daily report.
 * Represents a blocker requiring management intervention.
 */
interface HelpNeededItem {
	user: string;
	description: string;
	age?: string;
	ageDays: number | null;
	prNumber?: number;
	prUrl?: string;
}

/**
 * Find blockers that require management intervention.
 * A blocker qualifies when:
 * - Age >= ESCALATION_THRESHOLD_DAYS, OR
 * - Description contains escalation keywords
 */
function findHelpNeededBlockers(
	blockerGroups: UserBlockerGroup[],
): HelpNeededItem[] {
	const helpNeeded: HelpNeededItem[] = [];

	for (const group of blockerGroups) {
		for (const blocker of group.blockers) {
			const ageDays = parseAgeDays(blocker.age);
			const descLower = blocker.description.toLowerCase();

			const isOld = ageDays !== null && ageDays >= ESCALATION_THRESHOLD_DAYS;
			const hasKeyword = ESCALATION_KEYWORDS.some((kw) =>
				descLower.includes(kw),
			);

			if (isOld || hasKeyword) {
				const prUrl =
					blocker.prNumber && blocker.repo
						? buildPRUrl(blocker.repo, blocker.prNumber)
						: undefined;

				helpNeeded.push({
					user: group.user,
					description: blocker.description,
					age: blocker.age,
					ageDays,
					prNumber: blocker.prNumber,
					prUrl,
				});
			}
		}
	}

	// Sort by age (oldest first), then by description
	helpNeeded.sort((a, b) => {
		const ageA = a.ageDays ?? 0;
		const ageB = b.ageDays ?? 0;
		if (ageB !== ageA) return ageB - ageA;
		return a.description.localeCompare(b.description);
	});

	return helpNeeded;
}

/**
 * Find escalations (blockers > threshold days) from blocker groups.
 */
function findDailyEscalations(
	blockerGroups: UserBlockerGroup[],
): EscalationInfo[] {
	const escalations: EscalationInfo[] = [];

	for (const group of blockerGroups) {
		for (const blocker of group.blockers) {
			if (!blocker.age) continue;

			const match = blocker.age.match(/(\d+)\s*days?/);
			const daysStr = match?.[1];
			if (!daysStr) continue;

			const days = parseInt(daysStr, 10);
			if (days >= ESCALATION_THRESHOLD_DAYS) {
				escalations.push({
					description: blocker.description,
					owner: group.user,
					ageDays: days,
					prNumber: blocker.prNumber,
				});
			}
		}
	}

	// Sort by age (oldest first)
	escalations.sort((a, b) => b.ageDays - a.ageDays);
	return escalations;
}

/**
 * Truncate text to max length with ellipsis.
 */
function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Format the main embed for daily reports.
 * Compact summary with RAG status and escalation surfacing.
 */
export function formatDailyMainEmbed(data: DailyHybridData): DiscordEmbed {
	const { date, blockerGroups, shipped, stats, progress } = data;
	const color = getDailyRAGColor(stats);
	const escalations = findDailyEscalations(blockerGroups);
	const helpNeeded = findHelpNeededBlockers(blockerGroups);

	// Build status line
	const statusParts: string[] = [];
	if (stats.blockerCount > 0) {
		statusParts.push(
			`${stats.blockerCount} blocker${stats.blockerCount > 1 ? "s" : ""}`,
		);
	}
	if (stats.staleReviewCount > 0) {
		statusParts.push(
			`${stats.staleReviewCount} stale review${stats.staleReviewCount > 1 ? "s" : ""}`,
		);
	}
	const statusText =
		statusParts.length > 0 ? statusParts.join(" | ") : "On Track";

	// Build description
	let description = `**Status:** ${statusText}`;

	// Add top line summary
	if (shipped.length > 0) {
		description += `\n**Shipped:** ${shipped.length} PR${shipped.length > 1 ? "s" : ""} merged`;
	}
	if (progress.length > 0) {
		description += `\n**In Progress:** ${progress.length} feature${progress.length > 1 ? "s" : ""}`;
	}

	description = truncate(description, MAX_EMBED_DESCRIPTION_LENGTH);

	// Build fields
	const fields: DiscordEmbedField[] = [];

	// Stats fields (inline)
	if (stats.prsMerged > 0) {
		fields.push({
			name: "🚢 Shipped",
			value: `${stats.prsMerged} PR${stats.prsMerged > 1 ? "s" : ""}`,
			inline: true,
		});
	}
	if (stats.blockerCount > 0) {
		fields.push({
			name: "⚠️ Blockers",
			value: `${stats.blockerCount} active`,
			inline: true,
		});
	}
	if (stats.branchesActive > 0) {
		fields.push({
			name: "📍 In Progress",
			value: `${stats.branchesActive} feature${stats.branchesActive > 1 ? "s" : ""}`,
			inline: true,
		});
	}

	// Escalation field (if old blockers exist - ≥5 days)
	const topEscalation = escalations[0];

	// Help Needed field - show if:
	// 1. Multiple escalations exist (show count), OR
	// 2. Single escalation but no ESCALATION field (keyword-based, not age-based)
	// This avoids redundancy when single age-based escalation is already in ESCALATION
	const showHelpNeeded =
		helpNeeded.length > 1 ||
		(helpNeeded.length === 1 && escalations.length === 0);

	if (showHelpNeeded) {
		fields.push({
			name: "🙋 Help Needed",
			value: `${helpNeeded.length} escalation${helpNeeded.length > 1 ? "s" : ""}`,
			inline: true,
		});
	}
	if (topEscalation) {
		let escalationValue = `${topEscalation.description} — @${topEscalation.owner}`;
		if (escalations.length > 1) {
			escalationValue += ` (+${escalations.length - 1} more in thread)`;
		}
		fields.push({
			name: "🔴 ESCALATION",
			value: truncate(escalationValue, 200),
			inline: false,
		});
	}

	return {
		title: `🚀 Daily Summary — ${formatShortDate(date)}`,
		description,
		color,
		fields,
		footer: { text: "👇 Full breakdown in thread" },
	};
}

/**
 * Format the main embed for weekly reports.
 * Executive summary with RAG status and escalation surfacing.
 */
export function formatWeeklyMainEmbed(data: WeeklyHybridData): DiscordEmbed {
	const { weekOf, ragStatus, summary, stats, activeBlockers } = data;
	const color = getWeeklyRAGColor(ragStatus);

	// Build description with BLUF
	const statusLabel =
		ragStatus === "green"
			? "On Track"
			: ragStatus === "yellow"
				? "At Risk"
				: "Blocked";

	let description = `**Status:** ${statusLabel}`;
	if (summary.executiveSummary) {
		description += `\n**Top Line:** ${summary.executiveSummary}`;
	}

	description = truncate(description, MAX_EMBED_DESCRIPTION_LENGTH);

	// Build fields
	const fields: DiscordEmbedField[] = [];

	// Stats fields (inline)
	fields.push({
		name: "🚢 Shipped",
		value: `${stats.totalMerged} PR${stats.totalMerged !== 1 ? "s" : ""}`,
		inline: true,
	});

	if (stats.activeBlockerCount > 0) {
		fields.push({
			name: "⚠️ Blockers",
			value: `${stats.activeBlockerCount} active`,
			inline: true,
		});
	}

	if (stats.inProgressCount > 0) {
		fields.push({
			name: "📍 In Progress",
			value: `${stats.inProgressCount}`,
			inline: true,
		});
	}

	// Escalation field (if red status and we have blocker details)
	if (ragStatus === "red" && activeBlockers && activeBlockers.length > 0) {
		// Find escalations (blockers > 5 days)
		const escalations = activeBlockers
			.filter((b) => b.ageDays >= ESCALATION_THRESHOLD_DAYS)
			.sort((a, b) => b.ageDays - a.ageDays);

		const topBlocker = escalations[0];
		if (topBlocker) {
			let escalationValue = `${topBlocker.description} — @${topBlocker.owner}`;
			if (escalations.length > 1) {
				escalationValue += ` (+${escalations.length - 1} more in thread)`;
			}
			fields.push({
				name: "🔴 ESCALATION",
				value: truncate(escalationValue, 200),
				inline: false,
			});
		}
	}

	return {
		title: `📊 Weekly Summary — Week of ${formatShortWeekOf(weekOf)}`,
		description,
		color,
		fields,
		footer: { text: "👇 Full breakdown in thread" },
	};
}

/**
 * Format thread content for daily reports.
 * Full details with blockers, stale reviews, shipped, and in-progress.
 */
export function formatDailyThreadContent(data: DailyHybridData): string {
	const { date, blockerGroups, shipped, progress, staleReviews, stats } = data;
	const lines: string[] = [];

	lines.push(`📋 **Full Details — ${formatDate(date)}**`);
	lines.push("");

	// BLOCKERS SECTION
	if (blockerGroups.length > 0) {
		lines.push("🔴 **BLOCKERS**");
		lines.push("");
		for (const group of blockerGroups) {
			let headerSuffix = "";
			if (group.blockerCount > 1) {
				headerSuffix = ` (${group.blockerCount} blockers`;
				if (group.oldestAge) {
					headerSuffix += `, oldest: ${group.oldestAge}`;
				}
				headerSuffix += ")";
			}
			lines.push(`• **${group.user}**${headerSuffix}:`);

			for (const b of group.blockers) {
				const ageBadge = b.age ? ` (${b.age})` : "";
				const mentionText =
					b.mentionedUsers && b.mentionedUsers.length > 0
						? ` @${b.mentionedUsers.join(", @")}`
						: "";
				lines.push(`  → ${b.description}${mentionText}${ageBadge}`);
				const context = b.prTitle || b.branch;
				if (b.prNumber && b.repo) {
					lines.push(
						`    [PR #${b.prNumber}](${buildPRUrl(b.repo, b.prNumber)}): ${context}`,
					);
				} else if (b.prNumber) {
					lines.push(`    PR #${b.prNumber}: ${context}`);
				} else {
					lines.push(`    ${context}`);
				}
			}
			lines.push("");
		}
	}

	// HELP NEEDED SECTION (escalation subset - requires management intervention)
	const helpNeeded = findHelpNeededBlockers(blockerGroups);
	if (helpNeeded.length > 0) {
		lines.push("🙋 **HELP NEEDED**");
		lines.push("");
		for (const item of helpNeeded) {
			const ageBadge = item.age ? ` (${item.age})` : "";
			lines.push(`• ${item.description}${ageBadge} — @${item.user}`);
			if (item.prNumber && item.prUrl) {
				lines.push(`  [PR #${item.prNumber}](${item.prUrl})`);
			}
		}
		lines.push("");
	}

	// AWAITING REVIEW SECTION
	if (staleReviews.length > 0) {
		lines.push("⏳ **AWAITING REVIEW** (3+ days, no response)");
		lines.push("");
		for (const sr of staleReviews) {
			const prLink = `[PR #${sr.prNumber}](${buildPRUrl(sr.repo, sr.prNumber)})`;
			const daysLabel = sr.daysAgo === 1 ? "day" : "days";
			lines.push(
				`• ${prLink}: @${sr.reviewer} requested ${sr.daysAgo} ${daysLabel} ago — ${sr.prTitle}`,
			);
		}
		lines.push("");
	}

	// SHIPPED SECTION
	if (shipped.length > 0) {
		lines.push("🚢 **SHIPPED TODAY**");
		lines.push("");
		for (const f of shipped) {
			const authors = f.authors.join(", ");
			const prLink = `[PR #${f.prNumber}](${buildPRUrl(f.repo, f.prNumber)})`;
			lines.push(`• **${f.featureName}**`);
			lines.push(`  → ${f.impact}`);
			lines.push(`  → ${prLink} (${authors})`);
			lines.push("");
		}
	}

	// IN PROGRESS SECTION
	if (progress.length > 0) {
		lines.push("📍 **IN PROGRESS**");
		lines.push("");
		for (const p of progress) {
			const users = p.users.join(", ");
			const header = p.featureName || p.prTitle || p.branch;
			lines.push(`• **${header}**`);

			if (p.impact) {
				lines.push(`  → ${p.impact}`);
			}

			const activityIndicator =
				p.hasActivityToday === false ? " • awaiting review" : "";
			if (p.prNumber && p.repo) {
				lines.push(
					`  → ${users} • [PR #${p.prNumber}](${buildPRUrl(p.repo, p.prNumber)})${activityIndicator}`,
				);
			} else if (p.prNumber) {
				lines.push(`  → ${users} • PR #${p.prNumber}${activityIndicator}`);
			} else {
				lines.push(`  → ${users}${activityIndicator}`);
			}
			lines.push("");
		}
	}

	// STATS FOOTER
	const statParts: string[] = [];
	if (stats.prsMerged > 0) {
		statParts.push(
			`${stats.prsMerged} PR${stats.prsMerged > 1 ? "s" : ""} merged`,
		);
	}
	if (stats.blockerCount > 0) {
		// Omit oldest age if "today" - not headline-worthy
		const oldestSuffix =
			stats.oldestBlockerAge && stats.oldestBlockerAge !== "today"
				? ` (oldest: ${stats.oldestBlockerAge})`
				: "";
		statParts.push(
			`${stats.blockerCount} blocker${stats.blockerCount > 1 ? "s" : ""}${oldestSuffix}`,
		);
	}
	if (stats.staleReviewCount > 0) {
		statParts.push(
			`${stats.staleReviewCount} stale review${stats.staleReviewCount > 1 ? "s" : ""}`,
		);
	}
	if (stats.branchesActive > 0) {
		statParts.push(
			`${stats.branchesActive} feature${stats.branchesActive > 1 ? "s" : ""} in progress`,
		);
	}

	if (statParts.length > 0) {
		lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		lines.push(`📊 ${statParts.join(" • ")}`);
	}

	return lines.join("\n");
}

/**
 * Format thread content for weekly reports.
 * Full details with shipped items, blockers, help needed, and next week.
 */
export function formatWeeklyThreadContent(data: WeeklyHybridData): string {
	const { weekOf, summary, stats } = data;
	const lines: string[] = [];

	lines.push(`📋 **Full Details — Week of ${formatWeekOf(weekOf)}**`);
	lines.push("");

	// SHIPPED SECTION
	if (summary.shippedGroups.length > 0) {
		lines.push("🚢 **SHIPPED THIS WEEK**");
		lines.push("");
		for (const group of summary.shippedGroups) {
			const contributors = group.contributors.join(", ");
			lines.push(`• **${group.theme}** — ${group.summary} (${contributors})`);
		}
		lines.push("");
	}

	// BLOCKERS & RISKS SECTION
	lines.push("⚠️ **BLOCKERS & RISKS**");
	lines.push("");
	lines.push(`• ${summary.blockersAndRisks ?? "None active"}`);
	lines.push("");

	// HELP NEEDED SECTION
	lines.push("🙋 **HELP NEEDED**");
	lines.push("");
	lines.push(`• ${summary.helpNeeded ?? "None this week"}`);
	lines.push("");

	// NEXT WEEK SECTION
	if (summary.nextWeek) {
		lines.push("📍 **CARRYING INTO NEXT WEEK**");
		lines.push("");
		lines.push(`• ${summary.nextWeek}`);
		lines.push("");
	}

	// STATS FOOTER
	lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	const statParts: string[] = [];
	statParts.push(`${stats.totalMerged} PRs merged`);
	if (stats.blockersResolved > 0) {
		statParts.push(`${stats.blockersResolved} blockers resolved`);
	}
	if (stats.activeBlockerCount > 0) {
		statParts.push(`${stats.activeBlockerCount} active blockers`);
	}
	if (stats.inProgressCount > 0) {
		statParts.push(`${stats.inProgressCount} in progress`);
	}
	lines.push(statParts.join(" • "));

	return lines.join("\n");
}

/**
 * Get thread name for a report.
 */
export function getThreadName(type: ReportType, date: Date | string): string {
	if (type === "daily") {
		const dateStr =
			typeof date === "string"
				? date
				: (date.toISOString().split("T")[0] ?? "");
		return `🚀 ${formatShortDate(dateStr)} — Details`;
	}
	// weekly
	const weekDate = typeof date === "string" ? new Date(date) : date;
	return `📊 Week of ${formatShortWeekOf(weekDate)} — Details`;
}

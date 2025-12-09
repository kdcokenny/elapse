/**
 * Types for weekly rollup reports.
 */

/**
 * RAG status for weekly report health indicator.
 */
export type RAGStatus = "green" | "yellow" | "red";

/**
 * Data required to generate a weekly report.
 */
export interface WeeklyReportData {
	// Date range
	weekStart: Date; // Monday 00:00
	weekEnd: Date; // Friday 23:59

	// Shipped = all PRs merged Mon-Fri
	shipped: Array<{
		prNumber: number;
		title: string;
		author: string;
		translation: string;
		mergedAt: string;
		repo: string;
	}>;

	// Active blockers = unresolved as of report time
	activeBlockers: Array<{
		prNumber: number;
		title: string;
		author: string;
		reason: string;
		ageDays: number;
		mentionedUsers: string[];
	}>;

	// Resolved this week = for "wins" narrative
	resolvedBlockers: Array<{
		prNumber: number;
		reason: string;
		resolvedAt: string;
	}>;

	// Still stale by Friday
	staleReviews: Array<{
		prNumber: number;
		title: string;
		reviewer: string;
		daysWaiting: number;
	}>;

	// Open PRs as of Friday
	inProgress: Array<{
		prNumber: number;
		title: string;
		author: string;
		translation: string;
		status: "draft" | "open" | "in_review" | "approved";
	}>;

	// Computed stats
	stats: WeeklyStats;
}

/**
 * Statistics for the weekly report footer.
 */
export interface WeeklyStats {
	totalMerged: number;
	blockersResolved: number;
	activeBlockerCount: number;
	staleReviewCount: number;
	inProgressCount: number;
	contributorCount: number;
}

/**
 * AI-generated weekly summary output.
 *
 * DESIGN: Status sections vs Content sections
 * - blockersAndRisks: STATUS - nullable (AI returns null if none, we render "None active")
 * - helpNeeded: STATUS - nullable (AI returns null if none, we render "None this week")
 * - nextWeek: CONTENT - optional (only asked when in-progress work exists)
 *
 * Status sections are always rendered so execs can quickly confirm "all clear".
 * Null values get deterministic fallback text in formatting.
 */
export interface WeeklySummary {
	executiveSummary: string;
	shippedGroups: Array<{
		theme: string;
		summary: string;
		contributors: string[];
	}>;
	blockersAndRisks: string | null;
	helpNeeded: string | null;
	nextWeek?: string;
}

/**
 * Week boundary configuration.
 */
export interface WeekBoundary {
	start: Date; // Monday 00:00 local
	end: Date; // Friday 23:59 local
	dateStrings: string[]; // ["2025-02-24", "2025-02-25", ...]
}

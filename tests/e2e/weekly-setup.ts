/**
 * Weekly report E2E test utilities.
 * Format validation and setup helpers for weekly report testing.
 */

/**
 * Result of weekly format validation.
 */
export interface WeeklyFormatValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Validate that a weekly report thread content follows the expected format.
 * Thread content is the full breakdown posted in the Discord thread.
 *
 * Checks:
 * 1. Header format (Full Details — Week of)
 * 2. Shipped section format (if present)
 * 3. Required sections (BLOCKERS & RISKS, HELP NEEDED)
 * 4. Stats footer
 * 5. No raw technical data (SHAs, diffs)
 *
 * Note: RAG status and Top Line are now in the main embed, not thread content.
 */
export function validateWeeklyFormat(
	report: string,
): WeeklyFormatValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. Header check - thread content starts with "Full Details —"
	if (!report.includes("Full Details —")) {
		errors.push("Missing 'Full Details —' header");
	}

	// 2. Shipped section format (if present and has content)
	if (report.includes("SHIPPED THIS WEEK")) {
		// Should have bullet points with theme format: "• **Theme** — summary (contributors)"
		const shippedSection =
			report.split("SHIPPED THIS WEEK")[1]?.split("⚠️")[0] || "";
		if (shippedSection.includes("•") && !shippedSection.includes("**")) {
			warnings.push(
				"Shipped section items may be missing bold theme format (**Theme**)",
			);
		}
	}

	// 3. Status sections check (always required - they confirm "all clear" or list issues)
	const statusSections = ["BLOCKERS & RISKS", "HELP NEEDED"];
	for (const section of statusSections) {
		if (!report.includes(section)) {
			errors.push(`Missing required status section: '${section}'`);
		}
	}

	// 4. Content sections check (conditionally included based on data)
	// "Carrying Into Next Week" is only shown when in-progress work exists
	if (!report.includes("CARRYING INTO NEXT WEEK")) {
		// Not an error - this section is optional and only appears when in-progress data exists
		warnings.push(
			"Optional section not present: 'CARRYING INTO NEXT WEEK' (expected if no in-progress work)",
		);
	}

	// 5. Stats footer - should have "PRs merged" at minimum
	if (!report.includes("PRs merged")) {
		errors.push("Missing stats footer (should include 'PRs merged')");
	}

	// 6. No raw technical data
	if (report.match(/[a-f0-9]{40}/i)) {
		errors.push("Report contains raw SHA hashes");
	}
	if (report.includes("diff --git")) {
		errors.push("Report contains raw diff content");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Extract stats from a weekly report for verification.
 */
export function extractWeeklyStats(report: string): {
	prsMerged: number | null;
	blockersResolved: number | null;
	activeBlockers: number | null;
	inProgress: number | null;
} {
	// Parse "X PRs merged"
	const prsMergedMatch = report.match(/(\d+) PRs? merged/);
	const prsMerged = prsMergedMatch?.[1]
		? Number.parseInt(prsMergedMatch[1], 10)
		: null;

	// Parse "X blockers resolved"
	const resolvedMatch = report.match(/(\d+) blockers? resolved/);
	const blockersResolved = resolvedMatch?.[1]
		? Number.parseInt(resolvedMatch[1], 10)
		: null;

	// Parse "X active blockers"
	const activeMatch = report.match(/(\d+) active blockers?/);
	const activeBlockers = activeMatch?.[1]
		? Number.parseInt(activeMatch[1], 10)
		: null;

	// Parse "X in progress"
	const progressMatch = report.match(/(\d+) in progress/);
	const inProgress = progressMatch?.[1]
		? Number.parseInt(progressMatch[1], 10)
		: null;

	return { prsMerged, blockersResolved, activeBlockers, inProgress };
}

/**
 * Check if a weekly report embed has an executive summary that isn't a placeholder.
 * For hybrid reports, check the embed description for "Top Line:" or "Status:".
 */
export function hasSubstantiveExecutiveSummary(report: string): boolean {
	// Try new format first (embed description with Top Line)
	const topLineMatch = report.match(/\*\*Top Line:\*\*\s*(.+)/);
	if (topLineMatch?.[1]) {
		const summary = topLineMatch[1].trim();

		// Reject empty or placeholder summaries
		const placeholders = [
			"No activity",
			"N/A",
			"None",
			"TODO",
			"TBD",
			"(none)",
		];

		for (const placeholder of placeholders) {
			if (summary.toLowerCase().includes(placeholder.toLowerCase())) {
				return false;
			}
		}

		// Should have meaningful content (at least 10 characters)
		return summary.length >= 10;
	}

	// For thread-only validation, check if there's any substantive content
	// (shipped items, blockers, or help needed sections with content)
	const hasShippedContent =
		report.includes("SHIPPED THIS WEEK") &&
		!!report.match(/SHIPPED THIS WEEK[\s\S]*?•/);
	const hasBlockerContent =
		report.includes("BLOCKERS & RISKS") &&
		!report.includes("• None active") &&
		!!report.match(/BLOCKERS & RISKS[\s\S]*?•/);

	return hasShippedContent || hasBlockerContent;
}

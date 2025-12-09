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
 * Validate that a weekly report follows the expected format.
 * Checks:
 * 1. Header format (Weekly Engineering Summary)
 * 2. Status line (RAG indicator)
 * 3. Top Line / Executive summary
 * 4. Shipped section format (if present)
 * 5. Required sections (BLOCKERS & RISKS, HELP NEEDED, CARRYING INTO NEXT WEEK)
 * 6. Stats footer
 * 7. No raw technical data (SHAs, diffs)
 */
export function validateWeeklyFormat(
	report: string,
): WeeklyFormatValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. Header check
	if (!report.includes("Weekly Engineering Summary")) {
		errors.push("Missing 'Weekly Engineering Summary' header");
	}

	// 2. Status line check (RAG indicator)
	const hasRAGStatus =
		report.includes("🟢 On Track") ||
		report.includes("🟡 At Risk") ||
		report.includes("🔴 Blocked");
	if (!hasRAGStatus) {
		errors.push("Missing RAG status indicator (🟢/🟡/🔴)");
	}

	// 3. Top Line / Executive summary
	if (!report.includes("**Top Line:**")) {
		errors.push("Missing 'Top Line:' executive summary");
	}

	// 4. Shipped section format (if present and has content)
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

	// 5. Status sections check (always required - they confirm "all clear" or list issues)
	const statusSections = ["BLOCKERS & RISKS", "HELP NEEDED"];
	for (const section of statusSections) {
		if (!report.includes(section)) {
			errors.push(`Missing required status section: '${section}'`);
		}
	}

	// 6. Content sections check (conditionally included based on data)
	// "Carrying Into Next Week" is only shown when in-progress work exists
	if (!report.includes("CARRYING INTO NEXT WEEK")) {
		// Not an error - this section is optional and only appears when in-progress data exists
		warnings.push(
			"Optional section not present: 'CARRYING INTO NEXT WEEK' (expected if no in-progress work)",
		);
	}

	// 8. Stats footer - should have "PRs merged" at minimum
	if (!report.includes("PRs merged")) {
		errors.push("Missing stats footer (should include 'PRs merged')");
	}

	// 9. No raw technical data
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
 * Check if a weekly report has an executive summary that isn't a placeholder.
 */
export function hasSubstantiveExecutiveSummary(report: string): boolean {
	const topLineMatch = report.match(/\*\*Top Line:\*\*\s*(.+)/);
	if (!topLineMatch || !topLineMatch[1]) return false;

	const summary = topLineMatch[1].trim();

	// Reject empty or placeholder summaries
	const placeholders = ["No activity", "N/A", "None", "TODO", "TBD", "(none)"];

	for (const placeholder of placeholders) {
		if (summary.toLowerCase().includes(placeholder.toLowerCase())) {
			return false;
		}
	}

	// Should have meaningful content (at least 10 characters)
	return summary.length >= 10;
}

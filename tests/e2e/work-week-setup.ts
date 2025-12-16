/**
 * Work week scenario utilities for multi-day E2E testing.
 * Uses production-aligned fixtures and actual production code paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ProductionDayFixture,
	WorkDay,
	WorkWeekScenariosIndex,
} from "../fixtures/types";

// Paths
const WORK_WEEK_BASE = join(import.meta.dir, "../fixtures/synthetic/work-week");

/**
 * Scenario metadata.
 */
export interface ScenarioMeta {
	id: string;
	name: string;
	description: string;
	path?: string;
}

/**
 * Loaded work week scenario with all day data.
 */
export interface LoadedScenario {
	id: string;
	name: string;
	description: string;
	days: Map<WorkDay, ProductionDayFixture>;
}

// =============================================================================
// Scenario Loading
// =============================================================================

/**
 * List all available work week scenarios.
 */
export function listWorkWeekScenarios(): ScenarioMeta[] {
	const indexPath = join(WORK_WEEK_BASE, "scenarios.json");
	if (!existsSync(indexPath)) {
		return [];
	}

	const content = readFileSync(indexPath, "utf-8");
	const index = JSON.parse(content) as WorkWeekScenariosIndex;
	return index.scenarios;
}

/**
 * Load a specific work week scenario by ID.
 */
export function loadWorkWeekScenario(
	scenarioId: string,
): LoadedScenario | null {
	const scenarios = listWorkWeekScenarios();
	const meta = scenarios.find((s) => s.id === scenarioId);
	if (!meta) return null;

	const scenarioDir = join(WORK_WEEK_BASE, meta.path || meta.id);
	if (!existsSync(scenarioDir)) return null;

	// Load scenario.json for metadata
	const scenarioPath = join(scenarioDir, "scenario.json");
	const scenarioMeta = existsSync(scenarioPath)
		? (JSON.parse(readFileSync(scenarioPath, "utf-8")) as ScenarioMeta)
		: meta;

	// Load each day file
	const days = new Map<WorkDay, ProductionDayFixture>();
	const workDays: WorkDay[] = [
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
	];

	for (const day of workDays) {
		const dayPath = join(scenarioDir, `${day}.json`);
		if (existsSync(dayPath)) {
			const dayData = JSON.parse(
				readFileSync(dayPath, "utf-8"),
			) as ProductionDayFixture;
			days.set(day, dayData);
		}
	}

	return {
		id: scenarioMeta.id,
		name: scenarioMeta.name,
		description: scenarioMeta.description,
		days,
	};
}

// =============================================================================
// Format Validation (Research Document Compliance)
// =============================================================================

/**
 * Result of format validation against research document requirements.
 */
export interface FormatValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Validate that a daily report thread content follows the research document format.
 * Thread content is the full breakdown posted in the Discord thread.
 *
 * Checks:
 * 1. Header format (Full Details —)
 * 2. Section order (Blockers → Awaiting Review → Shipped → In Progress → Stats)
 * 3. No raw technical data (SHAs, diffs)
 * 4. PR traceability (PR #xxx present)
 * 5. Age badges format (if blockers present)
 * 6. Stale review format (if awaiting review present)
 *
 * Note: "Daily Engineering Summary" header is now in the main embed, not thread content.
 */
export function validateResearchFormat(report: string): FormatValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. Header check - thread content starts with "Full Details —"
	if (!report.includes("Full Details —")) {
		errors.push("Missing 'Full Details —' header");
	}

	// 2. Section order check (Blockers → Awaiting Review → Shipped → Progress → Stats)
	const sections = [
		"BLOCKERS",
		"AWAITING REVIEW",
		"SHIPPED TODAY",
		"IN PROGRESS",
	];
	let lastIndex = -1;
	for (const section of sections) {
		const index = report.indexOf(section);
		if (index > -1 && index < lastIndex) {
			errors.push(`Section '${section}' appears out of order`);
		}
		if (index > -1) lastIndex = index;
	}

	// 3. No raw technical data
	if (report.match(/[a-f0-9]{40}/i)) {
		errors.push("Report contains raw SHA hashes");
	}
	if (report.includes("diff --git")) {
		errors.push("Report contains raw diff content");
	}
	if (report.includes("@@")) {
		errors.push("Report contains raw diff markers");
	}

	// 4. PR traceability - if shipped section exists, check for PR refs
	if (report.includes("SHIPPED TODAY") && !report.match(/PR #\d+/)) {
		warnings.push("Shipped section may be missing PR references");
	}

	// 5. Age badge format check - if blockers section has multiple blockers, should have age info
	if (report.includes("BLOCKERS")) {
		// Check if any age badges are present (format: "(X days)" or "(today)")
		const hasAgeBadges = report.match(/\(\d+ days?\)|(\(today\))/);
		// Only warn if there are blockers but no age badges
		const blockerSection = report.split("BLOCKERS")[1]?.split("**")[0] || "";
		if (blockerSection.includes("→") && !hasAgeBadges) {
			warnings.push(
				"Blockers section may be missing age badges (expected format: '(X days)')",
			);
		}
	}

	// 6. Stale review format check - if awaiting review section exists, check format
	if (report.includes("AWAITING REVIEW")) {
		// Should have format: "@reviewer requested X days ago"
		const hasStaleFormat = report.match(/@\w+ requested \d+ days? ago/);
		if (!hasStaleFormat) {
			warnings.push(
				"Awaiting review section may be missing expected format: '@reviewer requested X days ago'",
			);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

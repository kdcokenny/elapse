/**
 * Work week scenario utilities for multi-day E2E testing.
 * Uses production-aligned fixtures and actual production code paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	generateBlockersSummary,
	type PRBlocker,
} from "../../src/core/blockers";
import {
	type ActivityStats,
	type BranchSummary,
	type FeatureSummary,
	formatFeatureCentricReport,
} from "../../src/core/formatting";
import type { StoredTranslation } from "../../src/redis";
import {
	generateFeatureShippedSection,
	generateProgressSection,
} from "../../src/reporter";
import type {
	DayExpectations,
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

/**
 * Result from processing a single day.
 */
export interface DayResult {
	day: WorkDay;
	blockers: PRBlocker[];
	shipped: FeatureSummary[];
	inProgress: BranchSummary[];
	/** Total translations processed (for stats). */
	translationCount: number;
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
// Scenario Runner (Using Production Functions)
// =============================================================================

/**
 * Run a single day of a work week scenario using production code paths.
 * This calls the actual generateFeatureShippedSection and generateProgressSection
 * functions from reporter.ts, ensuring tests validate production logic.
 */
export async function runScenarioDay(
	fixture: ProductionDayFixture,
	date: string,
): Promise<DayResult> {
	// Convert fixture format to Map (matching getAllForDate output)
	const shippedMap = new Map<string, StoredTranslation[]>(
		Object.entries(fixture.shipped),
	);
	const progressMap = new Map<string, StoredTranslation[]>(
		Object.entries(fixture.progress),
	);

	// Use production functions for report generation
	// Note: narrateFeature() will be mocked in tests to use fixture.featureNarrations
	const shipped = await generateFeatureShippedSection(shippedMap, date);
	const inProgress = generateProgressSection(progressMap);

	// Count total translations for stats
	let translationCount = 0;
	for (const translations of shippedMap.values()) {
		translationCount += translations.length;
	}
	for (const translations of progressMap.values()) {
		translationCount += translations.length;
	}

	return {
		day: "monday", // Will be set by caller
		blockers: fixture.blockers,
		shipped,
		inProgress,
		translationCount,
	};
}

/**
 * Run all days of a work week scenario.
 */
export async function runWorkWeekScenario(
	scenario: LoadedScenario,
): Promise<Map<WorkDay, DayResult>> {
	const results = new Map<WorkDay, DayResult>();
	const workDays: WorkDay[] = [
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
	];

	// Base date for the week (Monday)
	const baseDate = new Date("2025-02-24");

	for (let i = 0; i < workDays.length; i++) {
		const day = workDays[i];
		if (!day) continue;

		const dayData = scenario.days.get(day);
		if (dayData) {
			// Calculate date for this day
			const dayDate = new Date(baseDate);
			dayDate.setDate(baseDate.getDate() + i);
			const dateStr = dayDate.toISOString().split("T")[0] ?? "";

			const result = await runScenarioDay(dayData, dateStr);
			result.day = day;
			results.set(day, result);
		}
	}

	return results;
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Check if day result matches expectations.
 */
export function assertDayExpectations(
	result: DayResult,
	expectations: DayExpectations,
): { passed: boolean; errors: string[] } {
	const errors: string[] = [];

	// Check blocker count
	if (result.blockers.length !== expectations.blockers.count) {
		errors.push(
			`Expected ${expectations.blockers.count} blockers, got ${result.blockers.length}`,
		);
	}

	// Check blocker branches
	const blockerBranches = new Set(result.blockers.map((b) => b.branch));
	for (const expectedBranch of expectations.blockers.branches) {
		if (!blockerBranches.has(expectedBranch)) {
			errors.push(`Expected blocker on branch "${expectedBranch}"`);
		}
	}

	// Check blocker types
	const blockerTypes = new Set(result.blockers.map((b) => b.type));
	for (const expectedType of expectations.blockers.types) {
		if (!blockerTypes.has(expectedType as PRBlocker["type"])) {
			errors.push(`Expected blocker type "${expectedType}"`);
		}
	}

	// Check shipped feature count
	if (result.shipped.length !== expectations.shipped.featureCount) {
		errors.push(
			`Expected ${expectations.shipped.featureCount} shipped features, got ${result.shipped.length}`,
		);
	}

	// Check in-progress branch count
	if (result.inProgress.length !== expectations.inProgress.branchCount) {
		errors.push(
			`Expected ${expectations.inProgress.branchCount} in-progress branches, got ${result.inProgress.length}`,
		);
	}

	// Check in-progress branches
	const inProgressBranches = new Set(result.inProgress.map((p) => p.branch));
	for (const expectedBranch of expectations.inProgress.branches) {
		if (!inProgressBranches.has(expectedBranch)) {
			errors.push(`Expected in-progress branch "${expectedBranch}"`);
		}
	}

	return {
		passed: errors.length === 0,
		errors,
	};
}

/**
 * Get a summary of scenario results for debugging.
 */
export function summarizeScenarioResults(
	results: Map<WorkDay, DayResult>,
): string {
	const lines: string[] = [];

	for (const [day, result] of results) {
		lines.push(`\n=== ${day.toUpperCase()} ===`);
		lines.push(`Translations: ${result.translationCount}`);
		lines.push(`Blockers: ${result.blockers.length}`);
		for (const b of result.blockers) {
			lines.push(`  - [${b.type}] ${b.branch}: ${b.description}`);
		}
		lines.push(`Shipped: ${result.shipped.length}`);
		for (const s of result.shipped) {
			lines.push(`  - ${s.featureName} (PR #${s.prNumber})`);
		}
		lines.push(`In Progress: ${result.inProgress.length}`);
		for (const p of result.inProgress) {
			lines.push(`  - ${p.branch} (${p.users.join(", ")})`);
		}
	}

	return lines.join("\n");
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate a formatted report from a day's results.
 * Uses the feature-centric format from the research document.
 */
export function generateScenarioReport(day: DayResult, date: string): string {
	const blockerSummaries = generateBlockersSummary(day.blockers);

	const stats: ActivityStats = {
		prsMerged: day.shipped.length,
		branchesActive: day.inProgress.length,
		totalCommits: day.translationCount,
		blockerCount: day.blockers.length,
	};

	return formatFeatureCentricReport(
		date,
		blockerSummaries,
		day.shipped,
		day.inProgress,
		stats,
	);
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
 * Validate that a report follows the research document format.
 * Checks:
 * 1. Header format (Daily Engineering Summary)
 * 2. Section order (Blockers → Shipped → In Progress → Stats)
 * 3. No raw technical data (SHAs, diffs)
 * 4. PR traceability (PR #xxx present)
 */
export function validateResearchFormat(report: string): FormatValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. Header check
	if (!report.includes("Daily Engineering Summary")) {
		errors.push("Missing 'Daily Engineering Summary' header");
	}

	// 2. Section order check (Blockers → Shipped → Progress → Stats)
	const sections = ["BLOCKERS", "SHIPPED TODAY", "IN PROGRESS"];
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

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

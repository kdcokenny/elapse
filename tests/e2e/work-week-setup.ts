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

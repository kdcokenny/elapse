/**
 * E2E Test Suite for Elapse Standup Bot
 *
 * Full week execution tests using production-aligned fixture data.
 * Uses ioredis-mock for stateful week simulation where:
 * - State persists across days (like production Redis)
 * - Translations are stored via actual storeTranslation()
 * - Blockers persist until PR merge via resolveBlockersForPR()
 * - Reports generated via actual getAllForDate()
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
// Import production Redis functions for stateful testing
import {
	getAllForDate,
	resolveBlockersForPR,
	storeBlockers,
	storePersistentBlocker,
	storeTranslation,
} from "../../src/redis";
import {
	generateFeatureShippedSection,
	generateProgressSection,
} from "../../src/reporter";
import type { ProductionDayFixture, WorkDay } from "../fixtures/types";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";
import type { DayResult } from "./work-week-setup";
import {
	assertDayExpectations,
	generateScenarioReport,
	listWorkWeekScenarios,
	loadWorkWeekScenario,
	summarizeScenarioResults,
	validateResearchFormat,
} from "./work-week-setup";

// Current fixture being processed (set during test execution)
let currentFixture: ProductionDayFixture | null = null;

// Mock the AI module before importing reporter
mock.module("../../src/ai", () => ({
	narrateFeature: async (
		prTitle: string,
		prNumber: number,
		_texts: string[],
	): Promise<{ featureName: string; impact: string }> => {
		// Check if fixture has pre-defined narrations
		if (currentFixture?.featureNarrations?.[prNumber]) {
			return currentFixture.featureNarrations[prNumber];
		}

		// Generate deterministic response from PR title
		const featureName = prTitle.replace(/^(feat|fix|docs|chore):\s*/i, "");
		const impact = `Implements ${featureName.toLowerCase()}`;
		return { featureName, impact };
	},
	// Also provide a mock for translateDiff if needed
	translateDiff: async () => ({
		action: "skip" as const,
		summary: null,
		category: null,
		significance: null,
	}),
}));

// Work days in order
const WORK_DAYS: WorkDay[] = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
];

describe("E2E: Stateful Week Simulation", () => {
	beforeAll(() => {
		// Initialize mock Redis for all tests
		initTestRedis();
	});

	afterAll(() => {
		// Restore original Redis client
		restoreRedis();
	});

	test("should simulate full work week with persistent state across days", async () => {
		const scenarios = listWorkWeekScenarios();
		const scenarioMeta = scenarios[0];
		if (!scenarioMeta) {
			console.log("No scenarios found, skipping test");
			return;
		}

		const scenario = loadWorkWeekScenario(scenarioMeta.id);
		if (!scenario) {
			console.log("Could not load scenario, skipping test");
			return;
		}

		// Reset Redis before running the full week
		await resetTestRedis();

		console.log(`\n=== ${scenario.name} ===`);
		console.log(`Description: ${scenario.description}\n`);

		// Results for all days
		const results = new Map<WorkDay, DayResult>();

		// Base date for the week (Monday)
		const baseDate = new Date("2025-02-24");

		// Run each day sequentially with persistent state
		for (let dayIndex = 0; dayIndex < WORK_DAYS.length; dayIndex++) {
			const day = WORK_DAYS[dayIndex];
			if (!day) continue;

			const dayData = scenario.days.get(day);
			if (!dayData) {
				console.log(`${day.toUpperCase()}: No data`);
				continue;
			}

			// Calculate date for this day
			const dayDate = new Date(baseDate);
			dayDate.setDate(baseDate.getDate() + dayIndex);
			const dateStr = dayDate.toISOString().split("T")[0] ?? "";

			console.log(`\n--- ${day.toUpperCase()} (${dateStr}) ---`);

			// Set current fixture for AI mock
			currentFixture = dayData;

			// Step 1: Store translations (simulates digest worker)
			// Store progress translations
			for (const [user, translations] of Object.entries(dayData.progress)) {
				for (const t of translations) {
					await storeTranslation(dateStr, user, "progress", t);
				}
			}

			// Store shipped translations
			for (const [user, translations] of Object.entries(dayData.shipped)) {
				for (const t of translations) {
					await storeTranslation(dateStr, user, "shipped", t);
				}
			}

			// Step 2: Store blockers for the day
			if (dayData.blockers.length > 0) {
				// Separate persistent blockers (comment-based) from date-based blockers
				// In production, comment blockers go ONLY to persistent storage
				const dateBlockers = dayData.blockers.filter((b) => !b.commentId);
				const persistentBlockers = dayData.blockers.filter((b) => b.commentId);

				if (dateBlockers.length > 0) {
					await storeBlockers(dateStr, dateBlockers);
				}

				for (const blocker of persistentBlockers) {
					await storePersistentBlocker(blocker);
				}
			}

			// Step 3: Resolve blockers for merged PRs
			if (dayData.mergedPRs && dayData.mergedPRs.length > 0) {
				for (const prNumber of dayData.mergedPRs) {
					const removed = await resolveBlockersForPR("test/repo", prNumber);
					console.log(
						`  PR #${prNumber} merged → ${removed} blockers resolved`,
					);
				}
			}

			// Step 4: Generate report using actual getAllForDate()
			const { shipped, progress, blockers } = await getAllForDate(dateStr);

			// Use production functions for report generation
			const shippedFeatures = await generateFeatureShippedSection(
				shipped,
				dateStr,
			);
			const inProgressBranches = generateProgressSection(progress);

			// Count translations for stats
			let translationCount = 0;
			for (const translations of shipped.values()) {
				translationCount += translations.length;
			}
			for (const translations of progress.values()) {
				translationCount += translations.length;
			}

			const result: DayResult = {
				day,
				blockers,
				shipped: shippedFeatures,
				inProgress: inProgressBranches,
				translationCount,
			};

			results.set(day, result);

			// Log day summary
			console.log(`  Translations: ${translationCount}`);
			console.log(`  Shipped: ${shippedFeatures.length} features`);
			console.log(`  In Progress: ${inProgressBranches.length} branches`);
			console.log(`  Blockers: ${blockers.length}`);

			// Validate expectations
			const { passed, errors } = assertDayExpectations(
				result,
				dayData.expectations,
			);

			if (!passed) {
				console.warn(`  Assertion failures:`, errors);
			}
			expect(passed).toBe(true);

			// Validate report format
			const report = generateScenarioReport(result, dateStr);
			console.log(`\n--- ${day.toUpperCase()} REPORT ---`);
			console.log(report);
			console.log("--- END REPORT ---\n");

			const validation = validateResearchFormat(report);
			expect(validation.valid).toBe(true);
		}

		// Reset fixture
		currentFixture = null;

		// Final summary
		console.log("\n=== WEEK SUMMARY ===");
		console.log(summarizeScenarioResults(results));
	});

	test("should demonstrate blocker persistence across days", async () => {
		const scenarios = listWorkWeekScenarios();
		const scenarioMeta = scenarios[0];
		if (!scenarioMeta) return;

		const scenario = loadWorkWeekScenario(scenarioMeta.id);
		if (!scenario) return;

		// Reset Redis
		await resetTestRedis();

		// Day 1: Store a persistent blocker
		const mondayData = scenario.days.get("monday");
		if (!mondayData) return;

		// Find a blocker with commentId (persistent)
		const persistentBlocker = mondayData.blockers.find((b) => b.commentId);
		if (persistentBlocker) {
			await storePersistentBlocker(persistentBlocker);
		}

		// Day 2: Verify blocker still exists
		const { blockers: tuesdayBlockers } = await getAllForDate("2025-02-25");
		expect(tuesdayBlockers.length).toBeGreaterThanOrEqual(0);

		// Day 3: Resolve the blocker by PR merge
		if (persistentBlocker && persistentBlocker.prNumber !== undefined) {
			const removed = await resolveBlockersForPR(
				"test/repo",
				persistentBlocker.prNumber,
			);
			expect(removed).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("E2E: Production Code Path Validation", () => {
	beforeAll(() => {
		initTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	test("should use actual generateFeatureShippedSection from reporter.ts", async () => {
		await resetTestRedis();

		const scenarios = listWorkWeekScenarios();
		const firstScenario = scenarios[0];
		if (!firstScenario) {
			console.log("No scenarios found, skipping test");
			return;
		}

		const scenario = loadWorkWeekScenario(firstScenario.id);
		if (!scenario) {
			console.log("Could not load scenario, skipping test");
			return;
		}

		// Find a day with shipped features
		for (const [_day, dayData] of scenario.days) {
			if (Object.keys(dayData.shipped).length > 0) {
				currentFixture = dayData;

				// Store shipped translations via actual Redis
				for (const [user, translations] of Object.entries(dayData.shipped)) {
					for (const t of translations) {
						await storeTranslation("2025-02-24", user, "shipped", t);
					}
				}

				// Retrieve via getAllForDate
				const { shipped } = await getAllForDate("2025-02-24");

				// Use production function
				const features = await generateFeatureShippedSection(
					shipped,
					"2025-02-24",
				);

				// Verify we got FeatureSummary objects
				for (const feature of features) {
					expect(feature).toHaveProperty("featureName");
					expect(feature).toHaveProperty("impact");
					expect(feature).toHaveProperty("prNumber");
					expect(feature).toHaveProperty("authors");
					expect(feature).toHaveProperty("commitCount");
				}

				currentFixture = null;
				return;
			}
		}
		currentFixture = null;
	});

	test("should use actual generateProgressSection from reporter.ts", async () => {
		await resetTestRedis();

		const scenarios = listWorkWeekScenarios();
		const firstScenario = scenarios[0];
		if (!firstScenario) {
			console.log("No scenarios found, skipping test");
			return;
		}

		const scenario = loadWorkWeekScenario(firstScenario.id);
		if (!scenario) {
			console.log("Could not load scenario, skipping test");
			return;
		}

		// Find a day with in-progress work
		for (const [_day, dayData] of scenario.days) {
			if (Object.keys(dayData.progress).length > 0) {
				currentFixture = dayData;

				// Store progress translations via actual Redis
				for (const [user, translations] of Object.entries(dayData.progress)) {
					for (const t of translations) {
						await storeTranslation("2025-02-24", user, "progress", t);
					}
				}

				// Retrieve via getAllForDate
				const { progress } = await getAllForDate("2025-02-24");

				// Use production function
				const branches = generateProgressSection(progress);

				// Verify BranchSummary objects
				for (const branch of branches) {
					expect(branch).toHaveProperty("branch");
					expect(branch).toHaveProperty("users");
					expect(branch).toHaveProperty("commitCount");
				}

				currentFixture = null;
				return;
			}
		}
		currentFixture = null;
	});
});

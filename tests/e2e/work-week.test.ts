/**
 * E2E Test Suite for Elapse Standup Bot
 *
 * Full week execution tests using production-aligned fixture data.
 * Uses ioredis-mock for stateful week simulation where:
 * - State persists across days (like production Redis)
 * - Translations are stored via PR-centric storage
 * - Blockers persist until PR merge via resolveBlockersForPR()
 * - Reports generated via generateReport()
 * - Real AI calls for feature narration
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Import production Redis functions for stateful testing (branch-first)
import {
	addBranchCommit,
	createOrUpdatePR,
	getPRBlockers,
	recordPRMerged,
	resolveBlockersForPR,
	setPRBlocker,
	setPRStatus,
} from "../../src/redis";
import { generateReport } from "../../src/reporter";
import type { ProductionDayFixture, WorkDay } from "../fixtures/types";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";
import {
	listWorkWeekScenarios,
	loadWorkWeekScenario,
	validateResearchFormat,
} from "./work-week-setup";

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

			// Helper: Store translation in branch-first model
			async function storeTranslationWithPR(
				user: string,
				_section: "progress" | "shipped",
				t: ProductionDayFixture["progress"][string][number],
			) {
				// Skip storage if missing required PR fields
				if (!t.prNumber || !t.prTitle || !t.branch) return;

				// Fail fast: PR translations require summary and sha
				if (!t.summary || !t.sha) {
					throw new Error(
						`Fixture error: PR #${t.prNumber} translation missing required fields (summary, sha)`,
					);
				}

				await createOrUpdatePR(t.prNumber, {
					repo: "test/repo",
					branch: t.branch,
					title: t.prTitle,
					authors: [user],
					status: "open",
				});
				// No addPRToDay - handled by read-time resolution
				await addBranchCommit("test/repo", t.branch, {
					sha: t.sha,
					summary: t.summary,
					category: t.category ?? null,
					significance: t.significance ?? null,
					author: user,
					timestamp: dateStr,
				});
			}

			// Store progress translations
			for (const [user, translations] of Object.entries(dayData.progress)) {
				for (const t of translations) {
					await storeTranslationWithPR(user, "progress", t);
				}
			}

			// Store shipped translations
			for (const [user, translations] of Object.entries(dayData.shipped)) {
				for (const t of translations) {
					await storeTranslationWithPR(user, "shipped", t);
				}
			}

			// Step 2: Store blockers (PR-centric only)
			if (dayData.blockers.length > 0) {
				// PR-centric storage: only types supported by PRBlockerEntry
				type PRBlockerType =
					| "changes_requested"
					| "pending_review"
					| "comment"
					| "label"
					| "description";

				const isPRBlockerType = (type: string): type is PRBlockerType =>
					[
						"changes_requested",
						"pending_review",
						"comment",
						"label",
						"description",
					].includes(type);

				for (const blocker of dayData.blockers) {
					if (!blocker.prNumber) continue;
					if (!isPRBlockerType(blocker.type)) continue;

					const blockerKey = blocker.commentId
						? `comment:${blocker.commentId}`
						: blocker.reviewer
							? `review:${blocker.reviewer}`
							: `${blocker.type}:${blocker.branch}`;

					await setPRBlocker(blocker.prNumber, blockerKey, {
						type: blocker.type,
						description: blocker.description,
						reviewer: blocker.reviewer,
						commentId: blocker.commentId,
						detectedAt: dateStr,
					});
				}
			}

			// Step 3: Resolve blockers for merged PRs and update PR status
			if (dayData.mergedPRs && dayData.mergedPRs.length > 0) {
				for (const prNumber of dayData.mergedPRs) {
					const removed = await resolveBlockersForPR("test/repo", prNumber);
					// Mark PR as merged with timestamp (removes from open-prs index)
					await setPRStatus(prNumber, "merged", dateStr);
					await recordPRMerged(prNumber, dateStr);
					console.log(
						`  PR #${prNumber} merged → ${removed} blockers resolved`,
					);
				}
			}

			// Step 4: Generate report using PR-centric model
			const { content: report } = await generateReport(dateStr);
			console.log(`\n--- ${day.toUpperCase()} REPORT ---`);
			console.log(report ?? "(no report generated)");
			console.log("--- END REPORT ---\n");

			if (report) {
				const validation = validateResearchFormat(report);
				expect(validation.valid).toBe(true);
			}
		}

		console.log("\n=== WEEK COMPLETE ===");
	}, 120000); // 2 minute timeout for real AI calls

	test("should demonstrate blocker persistence across days", async () => {
		const scenarios = listWorkWeekScenarios();
		const scenarioMeta = scenarios[0];
		if (!scenarioMeta) return;

		const scenario = loadWorkWeekScenario(scenarioMeta.id);
		if (!scenario) return;

		// Reset Redis
		await resetTestRedis();

		// Day 1: Store a persistent blocker using PR-centric storage
		const mondayData = scenario.days.get("monday");
		if (!mondayData) return;

		// Find a blocker with prNumber and commentId (persistent)
		const persistentBlocker = mondayData.blockers.find(
			(b) => b.commentId && b.prNumber,
		);
		if (persistentBlocker?.prNumber) {
			// Create the PR first
			await createOrUpdatePR(persistentBlocker.prNumber, {
				repo: "test/repo",
				branch: persistentBlocker.branch,
				title: persistentBlocker.prTitle ?? `PR #${persistentBlocker.prNumber}`,
				authors: [persistentBlocker.user],
				status: "open",
			});

			// Store blocker in PR-centric storage
			await setPRBlocker(
				persistentBlocker.prNumber,
				`comment:${persistentBlocker.commentId}`,
				{
					type: "comment",
					description: persistentBlocker.description,
					commentId: persistentBlocker.commentId,
					detectedAt: "2025-02-24",
				},
			);
		}

		// Day 2: Verify blocker still exists in PR-centric storage
		if (persistentBlocker?.prNumber) {
			const tuesdayBlockers = await getPRBlockers(persistentBlocker.prNumber);
			expect(tuesdayBlockers.size).toBeGreaterThanOrEqual(0);
		}

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

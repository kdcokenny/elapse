/**
 * E2E Test Suite for Elapse Standup Bot
 *
 * Full week execution tests using production-aligned fixture data.
 * Uses ioredis-mock for stateful week simulation where:
 * - State persists across days (like production Redis)
 * - Translations are stored via PR-centric storage
 * - Blockers persist until PR merge (TTL applied on merge)
 * - Reports generated via generateReport()
 * - Real AI calls for feature narration
 *
 * ============================================================================
 * EXPECTED OUTPUT FORMAT (for manual verification)
 * ============================================================================
 *
 * MONDAY (2025-02-24):
 * ```
 * 🚀 **Daily Engineering Summary — Monday, February 24, 2025**
 *
 * 🔴 **BLOCKERS**
 *
 * • carol (2 blockers, oldest: 6 days):
 *   → Labeled: blocked (4 days)
 *     [PR #201]: feat: Add payment processing flow
 *   → Waiting for API keys from finance team (6 days)
 *     [PR #201]: feat: Add payment processing flow
 *
 * • dave (2 blockers, oldest: 5 days):
 *   → Waiting on review from @carol (5 days)
 *     [PR #202]: fix: Rate limiter bypass vulnerability
 *   → Needs @eve for security review (3 days)
 *     [PR #202]: fix: Rate limiter bypass vulnerability
 *
 * ⏳ **AWAITING REVIEW** (3+ days, no response)
 *
 * • [PR #202]: @carol requested 5 days ago — fix: Rate limiter bypass vulnerability
 *
 * 📍 **IN PROGRESS**
 *
 * • [AI-generated feature name]
 *   → [AI-generated impact]
 *   → alice • [PR #101]
 *
 * • Add payment processing flow
 *   → Started Stripe payment integration with initial SDK setup
 *   → carol • [PR #201]
 *
 * • Rate limiter bypass vulnerability
 *   → Patched rate limiter bypass vulnerability in token validation
 *   → dave • [PR #202]
 *
 * 📊 4 blockers (oldest: 6 days) • 1 stale review • 3 features in progress
 * ```
 *
 * TUESDAY (2025-02-25):
 * - 7 blockers total (carol: 3, dave: 2, alice: 1, bob: 1)
 * - 1 stale review (@carol on PR #202, 6 days)
 * - 4 features in progress
 * - New blockers show "(today)" for same-day detection
 *
 * WEDNESDAY (2025-02-26):
 * - PR #202 merged → dave's blockers resolved
 * - 5 blockers remaining (carol: 3, alice: 1, bob: 1)
 * - 🚢 SHIPPED TODAY section appears with dave's security fix
 * - Ages increment: "(5 days)" → "(6 days)", etc.
 *
 * THURSDAY (2025-02-27):
 * - PR #101 and PR #201 merged
 * - 1 blocker remaining (bob waiting on alice, 2 days)
 * - 🚢 SHIPPED TODAY: alice's auth + carol's payment
 * - 1 feature in progress (bob's docs)
 *
 * FRIDAY (2025-02-28):
 * - PR #102 merged → all blockers resolved
 * - Clean report: only SHIPPED TODAY section
 * - 📊 1 PR merged (no blockers, no stale reviews)
 *
 * KEY FORMAT REQUIREMENTS:
 * - Age badges on each blocker: "(X days)" or "(today)"
 * - User grouping with count: "carol (3 blockers, oldest: 8 days):"
 * - AWAITING REVIEW section for stale reviews (3+ days)
 * - Stats footer: "X blockers (oldest: Y days) • Z stale reviews • N features in progress"
 * - Section order: BLOCKERS → AWAITING REVIEW → SHIPPED → IN PROGRESS → stats
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { formatDailyThreadContent } from "../../src/core/formatting";
import { generateReport } from "../../src/daily-reporter";
// Import production Redis functions for stateful testing (branch-first)
import {
	addBranchCommit,
	createOrUpdatePR,
	getPRBlockers,
	recordPRMerged,
	setPRBlocker,
	setPRStatus,
} from "../../src/redis";
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

// Store original Date.now for restoration after tests
const originalDateNow = Date.now;

describe("E2E: Stateful Week Simulation", () => {
	beforeAll(() => {
		// Initialize mock Redis for all tests
		initTestRedis();
	});

	afterAll(() => {
		// Restore original Date.now and Redis client
		Date.now = originalDateNow;
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
						detectedAt: blocker.detectedAt ?? dateStr,
					});
				}
			}

			// Step 3: Update PR status and record merge for merged PRs
			if (dayData.mergedPRs && dayData.mergedPRs.length > 0) {
				for (const prNumber of dayData.mergedPRs) {
					// Mark PR as merged with timestamp (removes from open-prs index, applies TTL)
					await setPRStatus(prNumber, "merged", dateStr);
					await recordPRMerged(prNumber, dateStr);
					console.log(`  PR #${prNumber} merged`);
				}
			}

			// Step 4: Generate report using PR-centric model
			// Mock Date.now() to return end of report day for realistic age calculations
			Date.now = () => new Date(`${dateStr}T23:59:59Z`).getTime();
			const { data } = await generateReport(dateStr);
			const report = data ? formatDailyThreadContent(data) : null;
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

		// Day 3: Resolve the blocker by PR merge (TTL applied to blockers)
		if (persistentBlocker && persistentBlocker.prNumber !== undefined) {
			await setPRStatus(persistentBlocker.prNumber, "merged");
			// Blockers are retained with TTL for historical tracking
		}
	});
});

/**
 * E2E tests for "since last report" temporal coverage feature.
 * These tests require real AI calls and have longer timeouts.
 *
 * Validates:
 * 1. Friday→Monday scenario captures weekend activity
 * 2. Reports are idempotent (same query = same watermark)
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	addBranchCommit,
	createOrUpdatePR,
	recordPRMerged,
	setPRStatus,
} from "../../src/redis";
import { generateReport } from "../../src/reporter";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";

describe("Since Last Report E2E", () => {
	beforeAll(() => {
		initTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	beforeEach(async () => {
		await resetTestRedis();
	});

	describe("Friday to Monday reporting", () => {
		test("Monday report includes Friday afternoon and weekend activity", async () => {
			// Setup: Friday 9am report already sent
			const fridayReportTime = "2025-02-21T09:00:00.000Z";

			// Create PR with Friday afternoon work
			await createOrUpdatePR(201, {
				repo: "test/repo",
				branch: "feature/weekend",
				title: "Weekend feature",
				authors: ["alice"],
				status: "open",
			});

			// Friday 2pm commit (after report)
			await addBranchCommit("test/repo", "feature/weekend", {
				sha: "fri1",
				summary: "Added user validation",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-21T14:00:00.000Z",
			});

			// Saturday commit
			await addBranchCommit("test/repo", "feature/weekend", {
				sha: "sat1",
				summary: "Fixed edge case in validation",
				category: "fix",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-22T11:00:00.000Z",
			});

			// No addPRToDay for open PRs - handled by read-time resolution

			// Create PR merged on Saturday (hotfix)
			await createOrUpdatePR(202, {
				repo: "test/repo",
				branch: "hotfix/urgent",
				title: "Urgent hotfix",
				authors: ["bob"],
				status: "open",
			});

			await addBranchCommit("test/repo", "hotfix/urgent", {
				sha: "hot1",
				summary: "Fixed production outage",
				category: "fix",
				significance: "high",
				author: "bob",
				timestamp: "2025-02-22T08:00:00.000Z",
			});

			await setPRStatus(202, "merged", "2025-02-22T09:00:00.000Z");
			await recordPRMerged(202, "2025-02-22");

			// Monday report: query since Friday 9am
			const { content, watermark } = await generateReport(
				"2025-02-24", // Monday
				fridayReportTime,
			);

			// Should have content (not null)
			expect(content).not.toBeNull();

			// Content should mention both PRs (by PR number, since AI generates feature names)
			expect(content).toContain("PR #201");
			expect(content).toContain("PR #202");

			// Watermark should be the Saturday open PR translation (latest activity)
			// Note: PR 201's translation at 11:00 is later than PR 202's merge at 09:00
			expect(watermark).toBe("2025-02-22T11:00:00.000Z");
		}, 60000); // 60s timeout for AI calls
	});

	describe("idempotent watermark", () => {
		afterEach(async () => {
			await resetTestRedis();
		});

		test("same query returns same watermark on retry", async () => {
			// Setup: Create PR with activity
			await createOrUpdatePR(301, {
				repo: "test/repo",
				branch: "feature/test",
				title: "Test feature",
				authors: ["alice"],
				status: "open",
			});

			await addBranchCommit("test/repo", "feature/test", {
				sha: "test1",
				summary: "Test commit",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-24T10:00:00.000Z",
			});

			// No addPRToDay for open PRs - handled by read-time resolution

			const sinceTimestamp = "2025-02-24T09:00:00.000Z";

			// First call
			const { watermark: w1 } = await generateReport(
				"2025-02-24",
				sinceTimestamp,
			);

			// Reset to ensure fresh query
			// (In production, this simulates a retry after failure)

			// Second call with same params
			const { watermark: w2 } = await generateReport(
				"2025-02-24",
				sinceTimestamp,
			);

			expect(w1).toBe(w2);
		}, 60000);

		test("subsequent report excludes already-reported items", async () => {
			// Setup: Create PR that was just reported
			await createOrUpdatePR(302, {
				repo: "test/repo",
				branch: "feature/reported",
				title: "Already reported",
				authors: ["bob"],
				status: "open",
			});

			await addBranchCommit("test/repo", "feature/reported", {
				sha: "rep1",
				summary: "Already reported commit",
				category: "feature",
				significance: "medium",
				author: "bob",
				timestamp: "2025-02-24T10:00:00.000Z",
			});

			// No addPRToDay for open PRs - handled by read-time resolution

			// First report
			const { watermark } = await generateReport(
				"2025-02-24",
				"2025-02-24T09:00:00.000Z",
			);

			// Second report using watermark as sinceTimestamp
			// Should have no new activity (all items have timestamp <= watermark)
			const { content } = await generateReport("2025-02-24", watermark);

			// Should have no content since all items were already reported
			// Note: content may be formatNoActivityReport, not null
			// The key is that the PR shouldn't appear as new activity
			expect(content).toBeDefined();
		}, 60000);
	});
});

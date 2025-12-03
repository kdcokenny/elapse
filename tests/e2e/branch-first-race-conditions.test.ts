/**
 * Race Condition Tests for Branch-First Architecture
 *
 * These tests verify that the branch-first storage model correctly handles
 * timing scenarios that caused issues in the previous PR-centric architecture:
 *
 * OLD (race-prone): Push → lookup PR → store under PR
 * NEW (race-free): Push → store under branch → PR joins at report time
 *
 * The key insight: commits are stored by branch immediately, and PR association
 * happens at read time (report generation), eliminating all coordination.
 *
 * NOTE: These tests verify storage mechanics WITHOUT AI calls.
 * They test the Redis layer directly to ensure data is correctly stored and
 * retrievable regardless of timing.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	addBranchCommit,
	createOrUpdatePR,
	getAllOpenPRNumbers,
	getBranchCommits,
	getMergedPRsForDay,
	getPRMetadata,
	recordPRMerged,
	setPRStatus,
} from "../../src/redis";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";

const TEST_REPO = "test/race-conditions";

describe("Branch-First Race Condition Prevention", () => {
	beforeAll(() => {
		initTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	beforeEach(async () => {
		await resetTestRedis();
	});

	describe("Scenario 1: Commits BEFORE PR opens", () => {
		/**
		 * This was the original race condition:
		 * 1. Developer pushes commits to branch
		 * 2. Worker processes commits (fast)
		 * 3. Developer opens PR (later)
		 *
		 * OLD: Worker looked up PR → found nothing → orphaned commits
		 * NEW: Worker stores by branch → PR opens later → read-time resolution works
		 */
		test("commits pushed before PR.opened are stored and retrievable", async () => {
			const branch = "feature/early-commits";

			// Step 1: Push commits to branch BEFORE PR exists
			await addBranchCommit(TEST_REPO, branch, {
				sha: "early1",
				summary: "Early commit before PR opened",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-24T09:00:00.000Z",
			});

			await addBranchCommit(TEST_REPO, branch, {
				sha: "early2",
				summary: "Another early commit",
				category: "feature",
				significance: "low",
				author: "alice",
				timestamp: "2025-02-24T09:05:00.000Z",
			});

			// Verify commits are stored by branch (no PR association yet)
			const commitsBefore = await getBranchCommits(TEST_REPO, branch);
			expect(commitsBefore).toHaveLength(2);
			expect(commitsBefore[0]?.sha).toBe("early1");
			expect(commitsBefore[1]?.sha).toBe("early2");

			// Step 2: PR opens AFTER commits were pushed
			await createOrUpdatePR(100, {
				repo: TEST_REPO,
				branch: branch,
				title: "Feature: Late PR open",
				authors: ["alice"],
				status: "open",
				openedAt: "2025-02-24T09:30:00.000Z",
			});

			// Step 3: Verify PR metadata links to the branch
			const prMeta = await getPRMetadata(100);
			if (!prMeta) throw new Error("Expected PR metadata");
			expect(prMeta.branch).toBe(branch);

			// Step 4: Verify commits are STILL retrievable via branch
			// This is the key test - branch storage survives PR opening
			const commitsAfter = await getBranchCommits(TEST_REPO, branch);
			expect(commitsAfter).toHaveLength(2);

			// Step 5: Read-time resolution can now join PR → branch → commits
			const resolvedCommits = await getBranchCommits(TEST_REPO, prMeta.branch);
			expect(resolvedCommits).toHaveLength(2);
		});
	});

	describe("Scenario 2: PR opens with no commits initially", () => {
		/**
		 * Edge case: PR is created from an empty branch, commits come later.
		 * This tests that late-arriving commits are still associated.
		 */
		test("commits pushed after PR.opened are stored correctly", async () => {
			const branch = "feature/late-commits";

			// Step 1: PR opens first (draft PR, no commits yet)
			await createOrUpdatePR(200, {
				repo: TEST_REPO,
				branch: branch,
				title: "Feature: Empty draft PR",
				authors: ["bob"],
				status: "open",
				openedAt: "2025-02-24T08:00:00.000Z",
			});

			// Verify PR exists with no commits on branch
			const prMeta = await getPRMetadata(200);
			if (!prMeta) throw new Error("Expected PR metadata");
			const commitsBefore = await getBranchCommits(TEST_REPO, branch);
			expect(commitsBefore).toHaveLength(0);

			// Step 2: Commits arrive later
			await addBranchCommit(TEST_REPO, branch, {
				sha: "late1",
				summary: "First actual implementation",
				category: "feature",
				significance: "high",
				author: "bob",
				timestamp: "2025-02-24T10:00:00.000Z",
			});

			await addBranchCommit(TEST_REPO, branch, {
				sha: "late2",
				summary: "More implementation",
				category: "feature",
				significance: "medium",
				author: "bob",
				timestamp: "2025-02-24T11:00:00.000Z",
			});

			// Step 3: Verify commits are retrievable via branch
			const commitsAfter = await getBranchCommits(TEST_REPO, branch);
			expect(commitsAfter).toHaveLength(2);

			// Step 4: Read-time resolution works
			const resolvedCommits = await getBranchCommits(TEST_REPO, prMeta.branch);
			expect(resolvedCommits).toHaveLength(2);
		});
	});

	describe("Scenario 3: Interleaved timing", () => {
		/**
		 * Complex scenario: commits arrive before, during, and after PR lifecycle.
		 * All commits on the branch should be associated with the PR.
		 */
		test("all commits on branch are stored regardless of timing", async () => {
			const branch = "feature/interleaved";

			// Commit 1: Before PR
			await addBranchCommit(TEST_REPO, branch, {
				sha: "before1",
				summary: "Commit before PR opened",
				category: "feature",
				significance: "medium",
				author: "charlie",
				timestamp: "2025-02-24T08:00:00.000Z",
			});

			// PR opens
			await createOrUpdatePR(300, {
				repo: TEST_REPO,
				branch: branch,
				title: "Feature: Interleaved commits",
				authors: ["charlie"],
				status: "open",
				openedAt: "2025-02-24T09:00:00.000Z",
			});

			// Commit 2: After PR opened
			await addBranchCommit(TEST_REPO, branch, {
				sha: "during1",
				summary: "Commit during PR review",
				category: "fix",
				significance: "low",
				author: "charlie",
				timestamp: "2025-02-24T10:00:00.000Z",
			});

			// Commit 3: Right before merge
			await addBranchCommit(TEST_REPO, branch, {
				sha: "during2",
				summary: "Final fixes before merge",
				category: "fix",
				significance: "medium",
				author: "charlie",
				timestamp: "2025-02-24T11:00:00.000Z",
			});

			// Verify all 3 commits are on the branch
			const branchCommits = await getBranchCommits(TEST_REPO, branch);
			expect(branchCommits).toHaveLength(3);
			expect(branchCommits.map((c) => c.sha)).toEqual([
				"before1",
				"during1",
				"during2",
			]);

			// Merge the PR
			await setPRStatus(300, "merged", "2025-02-24T12:00:00.000Z");
			await recordPRMerged(300, "2025-02-24");

			// Verify PR appears in merged PRs for the day
			const mergedPRs = await getMergedPRsForDay("2025-02-24");
			expect(mergedPRs).toContain(300);

			// Verify PR metadata still has correct branch
			const prMeta = await getPRMetadata(300);
			expect(prMeta?.branch).toBe(branch);

			// Commits are still retrievable (cleanup is background job)
			const commitsAfterMerge = await getBranchCommits(TEST_REPO, branch);
			expect(commitsAfterMerge).toHaveLength(3);
		});
	});

	describe("Scenario 4: Multiple PRs on different branches", () => {
		/**
		 * Regression test: ensure branch isolation works correctly.
		 * Commits on branch A should not appear in PR for branch B.
		 */
		test("commits are isolated to their respective branches", async () => {
			const branchA = "feature/branch-a";
			const branchB = "feature/branch-b";

			// Commits on branch A
			await addBranchCommit(TEST_REPO, branchA, {
				sha: "a1",
				summary: "Work on feature A",
				category: "feature",
				significance: "high",
				author: "alice",
				timestamp: "2025-02-24T09:00:00.000Z",
			});

			await addBranchCommit(TEST_REPO, branchA, {
				sha: "a2",
				summary: "More work on feature A",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-24T09:30:00.000Z",
			});

			// Commits on branch B
			await addBranchCommit(TEST_REPO, branchB, {
				sha: "b1",
				summary: "Work on feature B",
				category: "feature",
				significance: "high",
				author: "bob",
				timestamp: "2025-02-24T09:00:00.000Z",
			});

			// PR for branch A
			await createOrUpdatePR(400, {
				repo: TEST_REPO,
				branch: branchA,
				title: "Feature A",
				authors: ["alice"],
				status: "open",
			});

			// PR for branch B
			await createOrUpdatePR(401, {
				repo: TEST_REPO,
				branch: branchB,
				title: "Feature B",
				authors: ["bob"],
				status: "open",
			});

			// Verify isolation - branch A has 2 commits, branch B has 1
			const commitsA = await getBranchCommits(TEST_REPO, branchA);
			const commitsB = await getBranchCommits(TEST_REPO, branchB);

			expect(commitsA).toHaveLength(2);
			expect(commitsA[0]?.sha).toBe("a1");
			expect(commitsA[1]?.sha).toBe("a2");

			expect(commitsB).toHaveLength(1);
			expect(commitsB[0]?.sha).toBe("b1");

			// Verify PR metadata correctly maps to branches
			const prMetaA = await getPRMetadata(400);
			const prMetaB = await getPRMetadata(401);
			if (!prMetaA || !prMetaB) throw new Error("Expected PR metadata");

			expect(prMetaA.branch).toBe(branchA);
			expect(prMetaB.branch).toBe(branchB);

			// Read-time resolution respects isolation
			const resolvedA = await getBranchCommits(TEST_REPO, prMetaA.branch);
			const resolvedB = await getBranchCommits(TEST_REPO, prMetaB.branch);

			expect(resolvedA).toHaveLength(2);
			expect(resolvedB).toHaveLength(1);
		});
	});

	describe("Scenario 5: Worker processes commit while PR webhook is in-flight", () => {
		/**
		 * Simulates the exact race condition we fixed:
		 * - Push webhook arrives, triggers worker
		 * - Worker finishes FAST (before PR.opened webhook)
		 * - PR.opened webhook arrives later
		 *
		 * In old architecture: orphan commit
		 * In new architecture: branch storage means it's found at report time
		 */
		test("fast worker completion does not orphan commits", async () => {
			const branch = "feature/fast-worker";

			// Simulate: Worker processes commit immediately (stores by branch)
			// This happens BEFORE PR exists
			await addBranchCommit(TEST_REPO, branch, {
				sha: "fast1",
				summary: "Commit processed by fast worker",
				category: "feature",
				significance: "high",
				author: "dave",
				timestamp: "2025-02-24T09:00:00.000Z",
			});

			// At this point, there's NO PR - in old system, this would be orphaned
			// Verify commit exists on branch
			const commitsBefore = await getBranchCommits(TEST_REPO, branch);
			expect(commitsBefore).toHaveLength(1);

			// PR.opened webhook finally arrives (network delay, queue backup, etc.)
			await createOrUpdatePR(500, {
				repo: TEST_REPO,
				branch: branch,
				title: "Feature: Fast worker test",
				authors: ["dave"],
				status: "open",
				openedAt: "2025-02-24T09:01:00.000Z",
			});

			// Verify PR is in open PRs list
			const openPRs = await getAllOpenPRNumbers();
			expect(openPRs).toContain(500);

			// Verify PR metadata has correct branch
			const prMeta = await getPRMetadata(500);
			if (!prMeta) throw new Error("Expected PR metadata");
			expect(prMeta.branch).toBe(branch);

			// KEY TEST: Commits are still there and resolvable via PR → branch
			const resolvedCommits = await getBranchCommits(TEST_REPO, prMeta.branch);
			expect(resolvedCommits).toHaveLength(1);
			expect(resolvedCommits[0]?.sha).toBe("fast1");
		});
	});

	describe("Scenario 6: PR merge records to daily index correctly", () => {
		/**
		 * Tests that merged PRs are correctly recorded in the daily index
		 * for report generation.
		 */
		test("merged PRs appear in daily index", async () => {
			const branch = "feature/merge-test";

			// Setup: Create PR with commits
			await createOrUpdatePR(600, {
				repo: TEST_REPO,
				branch: branch,
				title: "Feature: Merge test",
				authors: ["eve"],
				status: "open",
			});

			await addBranchCommit(TEST_REPO, branch, {
				sha: "merge1",
				summary: "Ready to merge",
				category: "feature",
				significance: "high",
				author: "eve",
				timestamp: "2025-02-24T09:00:00.000Z",
			});

			// Verify PR is in open list before merge
			const openBefore = await getAllOpenPRNumbers();
			expect(openBefore).toContain(600);

			// Merge the PR
			await setPRStatus(600, "merged", "2025-02-24T10:00:00.000Z");
			await recordPRMerged(600, "2025-02-24");

			// Verify PR status is updated
			const prMeta = await getPRMetadata(600);
			expect(prMeta?.status).toBe("merged");

			// Verify PR appears in merged PRs for the day
			const mergedPRs = await getMergedPRsForDay("2025-02-24");
			expect(mergedPRs).toContain(600);

			// Verify PR is NOT in open list after merge
			const openAfter = await getAllOpenPRNumbers();
			expect(openAfter).not.toContain(600);
		});
	});
});

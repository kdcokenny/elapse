import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	clearOrphanCommits,
	getOrphanCommits,
	type OrphanCommit,
	trackOrphanCommit,
} from "../../src/redis";
import { initTestRedis, resetTestRedis, restoreRedis } from "../e2e/test-redis";

describe("Orphan Commit Tracking", () => {
	beforeAll(() => {
		initTestRedis();
	});

	beforeEach(async () => {
		await resetTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	const makeOrphanCommit = (
		overrides: Partial<OrphanCommit> = {},
	): OrphanCommit => ({
		sha: "abc123def456",
		summary: "Added user authentication",
		category: "feature",
		significance: "high",
		author: "developer",
		timestamp: "2025-01-15T10:30:00.000Z",
		...overrides,
	});

	describe("trackOrphanCommit", () => {
		test("stores an orphan commit", async () => {
			const orphan = makeOrphanCommit();

			await trackOrphanCommit("owner/repo", "feature/auth", orphan);

			const orphans = await getOrphanCommits("owner/repo", "feature/auth");
			expect(orphans).toHaveLength(1);
			expect(orphans[0]).toMatchObject({
				sha: "abc123def456",
				summary: "Added user authentication",
				author: "developer",
			});
		});

		test("stores multiple orphans on the same branch", async () => {
			const orphan1 = makeOrphanCommit({ sha: "commit1" });
			const orphan2 = makeOrphanCommit({ sha: "commit2" });

			await trackOrphanCommit("owner/repo", "feature/auth", orphan1);
			await trackOrphanCommit("owner/repo", "feature/auth", orphan2);

			const orphans = await getOrphanCommits("owner/repo", "feature/auth");
			expect(orphans).toHaveLength(2);
			expect(orphans.map((o) => o.sha)).toEqual(["commit1", "commit2"]);
		});

		test("isolates orphans by repo and branch", async () => {
			const orphan1 = makeOrphanCommit({ sha: "commit1" });
			const orphan2 = makeOrphanCommit({ sha: "commit2" });

			await trackOrphanCommit("owner/repo1", "feature/auth", orphan1);
			await trackOrphanCommit("owner/repo2", "feature/auth", orphan2);

			const orphans1 = await getOrphanCommits("owner/repo1", "feature/auth");
			const orphans2 = await getOrphanCommits("owner/repo2", "feature/auth");

			expect(orphans1).toHaveLength(1);
			expect(orphans1[0]?.sha).toBe("commit1");
			expect(orphans2).toHaveLength(1);
			expect(orphans2[0]?.sha).toBe("commit2");
		});
	});

	describe("getOrphanCommits", () => {
		test("returns empty array when no orphans exist", async () => {
			const orphans = await getOrphanCommits(
				"owner/repo",
				"nonexistent-branch",
			);
			expect(orphans).toEqual([]);
		});

		test("preserves all orphan fields", async () => {
			const orphan = makeOrphanCommit({
				sha: "full-commit",
				summary: "Full commit summary",
				category: "improvement",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-20T15:45:00.000Z",
			});

			await trackOrphanCommit("owner/repo", "feature/full", orphan);

			const orphans = await getOrphanCommits("owner/repo", "feature/full");
			expect(orphans[0]).toEqual(orphan);
		});
	});

	describe("clearOrphanCommits", () => {
		test("removes all orphans for a branch", async () => {
			await trackOrphanCommit(
				"owner/repo",
				"feature/auth",
				makeOrphanCommit({ sha: "c1" }),
			);
			await trackOrphanCommit(
				"owner/repo",
				"feature/auth",
				makeOrphanCommit({ sha: "c2" }),
			);

			await clearOrphanCommits("owner/repo", "feature/auth");

			const orphans = await getOrphanCommits("owner/repo", "feature/auth");
			expect(orphans).toEqual([]);
		});

		test("does not affect orphans on other branches", async () => {
			await trackOrphanCommit(
				"owner/repo",
				"feature/a",
				makeOrphanCommit({ sha: "c1" }),
			);
			await trackOrphanCommit(
				"owner/repo",
				"feature/b",
				makeOrphanCommit({ sha: "c2" }),
			);

			await clearOrphanCommits("owner/repo", "feature/a");

			const orphansA = await getOrphanCommits("owner/repo", "feature/a");
			const orphansB = await getOrphanCommits("owner/repo", "feature/b");
			expect(orphansA).toEqual([]);
			expect(orphansB).toHaveLength(1);
		});

		test("is idempotent - clearing non-existent orphans does nothing", async () => {
			// Should not throw
			await clearOrphanCommits("owner/repo", "nonexistent-branch");

			const orphans = await getOrphanCommits(
				"owner/repo",
				"nonexistent-branch",
			);
			expect(orphans).toEqual([]);
		});
	});

	describe("backfill workflow", () => {
		test("complete orphan -> PR backfill flow", async () => {
			// 1. Push arrives before PR - commits tracked as orphans
			const orphan1 = makeOrphanCommit({
				sha: "commit1",
				summary: "Added login form",
				timestamp: "2025-01-15T10:30:00.000Z",
			});
			const orphan2 = makeOrphanCommit({
				sha: "commit2",
				summary: "Added logout button",
				timestamp: "2025-01-15T10:35:00.000Z",
			});

			await trackOrphanCommit("owner/repo", "feature/auth", orphan1);
			await trackOrphanCommit("owner/repo", "feature/auth", orphan2);

			// 2. PR opened - fetch orphans
			const orphans = await getOrphanCommits("owner/repo", "feature/auth");
			expect(orphans).toHaveLength(2);

			// 3. Extract unique dates for daily index update
			const dates = [...new Set(orphans.map((o) => o.timestamp.split("T")[0]))];
			expect(dates).toEqual(["2025-01-15"]);

			// 4. After backfilling to PR, clear orphans
			await clearOrphanCommits("owner/repo", "feature/auth");

			// 5. Verify orphans are gone
			const remaining = await getOrphanCommits("owner/repo", "feature/auth");
			expect(remaining).toEqual([]);
		});
	});
});

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { PRBlocker } from "../../src/core/blockers";
import {
	getActivePersistentBlockers,
	resolveReviewBlocker,
	storeReviewBlocker,
} from "../../src/redis";
import { initTestRedis, resetTestRedis, restoreRedis } from "../e2e/test-redis";

describe("Review Blocker Storage", () => {
	beforeAll(() => {
		initTestRedis();
	});

	beforeEach(async () => {
		await resetTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	const makeReviewBlocker = (
		overrides: Partial<PRBlocker> = {},
	): PRBlocker => ({
		type: "changes_requested",
		description: "Changes requested by @reviewer",
		reviewer: "reviewer-alice",
		prNumber: 42,
		prTitle: "feat: add user auth",
		branch: "feature/auth",
		user: "developer-bob",
		detectedAt: "2025-01-15T10:30:00Z",
		...overrides,
	});

	describe("storeReviewBlocker", () => {
		test("stores a review blocker", async () => {
			const blocker = makeReviewBlocker();

			await storeReviewBlocker(blocker);

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(1);
			expect(blockers[0]).toMatchObject({
				type: "changes_requested",
				reviewer: "reviewer-alice",
				prNumber: 42,
				branch: "feature/auth",
			});
		});

		test("does not store blocker without reviewer", async () => {
			const blocker = makeReviewBlocker({ reviewer: undefined });

			await storeReviewBlocker(blocker);

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(0);
		});

		test("stores multiple blockers from different reviewers", async () => {
			const blocker1 = makeReviewBlocker({ reviewer: "alice" });
			const blocker2 = makeReviewBlocker({ reviewer: "bob" });

			await storeReviewBlocker(blocker1);
			await storeReviewBlocker(blocker2);

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(2);
			expect(blockers.map((b) => b.reviewer).sort()).toEqual(["alice", "bob"]);
		});

		test("overwrites blocker from same reviewer on same PR", async () => {
			const blocker1 = makeReviewBlocker({
				reviewer: "alice",
				description: "First review",
			});
			const blocker2 = makeReviewBlocker({
				reviewer: "alice",
				description: "Second review",
			});

			await storeReviewBlocker(blocker1);
			await storeReviewBlocker(blocker2);

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(1);
			expect(blockers[0]?.description).toBe("Second review");
		});
	});

	describe("resolveReviewBlocker", () => {
		test("resolves an existing blocker", async () => {
			const blocker = makeReviewBlocker();
			await storeReviewBlocker(blocker);

			const resolved = await resolveReviewBlocker(42, "reviewer-alice");

			expect(resolved).toBe(true);
			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(0);
		});

		test("returns false when no blocker exists", async () => {
			const resolved = await resolveReviewBlocker(42, "nonexistent-reviewer");

			expect(resolved).toBe(false);
		});

		test("only resolves the specific reviewer's blocker", async () => {
			await storeReviewBlocker(makeReviewBlocker({ reviewer: "alice" }));
			await storeReviewBlocker(makeReviewBlocker({ reviewer: "bob" }));

			await resolveReviewBlocker(42, "alice");

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(1);
			expect(blockers[0]?.reviewer).toBe("bob");
		});

		test("only resolves blocker for the specific PR", async () => {
			await storeReviewBlocker(makeReviewBlocker({ prNumber: 42 }));
			await storeReviewBlocker(makeReviewBlocker({ prNumber: 99 }));

			await resolveReviewBlocker(42, "reviewer-alice");

			const blockers = await getActivePersistentBlockers();
			expect(blockers).toHaveLength(1);
			expect(blockers[0]?.prNumber).toBe(99);
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	type BlockerSummary,
	detectStaleReviews,
	groupBlockersByUser,
	type StaleReviewInput,
} from "../../src/core/blockers";

function assertDefined<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`${name} is undefined`);
	return value;
}

const makeBlocker = (
	overrides: Partial<BlockerSummary> = {},
): BlockerSummary => ({
	branch: "feature/test",
	description: "Test blocker",
	user: "alice",
	...overrides,
});

describe("groupBlockersByUser", () => {
	test("returns empty array for no blockers", () => {
		expect(groupBlockersByUser([])).toEqual([]);
	});

	test("groups single blocker for single user", () => {
		const blockers = [
			makeBlocker({ user: "alice", description: "Review needed" }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(1);
		const first = assertDefined(groups[0], "groups[0]");
		expect(first.user).toBe("alice");
		expect(first.blockers).toHaveLength(1);
		const firstBlocker = assertDefined(first.blockers[0], "blockers[0]");
		expect(firstBlocker.description).toBe("Review needed");
	});

	test("groups multiple blockers for same user", () => {
		const blockers = [
			makeBlocker({
				user: "carol",
				description: "Security review",
				prNumber: 123,
			}),
			makeBlocker({ user: "carol", description: "API changes", prNumber: 456 }),
			makeBlocker({ user: "carol", description: "CI failing", prNumber: 789 }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(1);
		const first = assertDefined(groups[0], "groups[0]");
		expect(first.user).toBe("carol");
		expect(first.blockers).toHaveLength(3);
	});

	test("groups blockers from different users separately", () => {
		const blockers = [
			makeBlocker({ user: "alice", description: "Review needed" }),
			makeBlocker({ user: "bob", description: "CI failing" }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(2);
		const users = groups.map((g) => g.user);
		expect(users).toContain("alice");
		expect(users).toContain("bob");
	});

	test("sorts users by blocker count (descending)", () => {
		const blockers = [
			makeBlocker({ user: "alice", description: "Blocker 1" }),
			makeBlocker({ user: "carol", description: "Blocker 1" }),
			makeBlocker({ user: "carol", description: "Blocker 2" }),
			makeBlocker({ user: "carol", description: "Blocker 3" }),
			makeBlocker({ user: "bob", description: "Blocker 1" }),
			makeBlocker({ user: "bob", description: "Blocker 2" }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(3);
		expect(assertDefined(groups[0], "groups[0]").user).toBe("carol"); // 3 blockers
		expect(assertDefined(groups[1], "groups[1]").user).toBe("bob"); // 2 blockers
		expect(assertDefined(groups[2], "groups[2]").user).toBe("alice"); // 1 blocker
	});

	test("sorts alphabetically when blocker counts are equal", () => {
		const blockers = [
			makeBlocker({ user: "zara", description: "Review" }),
			makeBlocker({ user: "alice", description: "Review" }),
			makeBlocker({ user: "mike", description: "Review" }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(3);
		expect(assertDefined(groups[0], "groups[0]").user).toBe("alice");
		expect(assertDefined(groups[1], "groups[1]").user).toBe("mike");
		expect(assertDefined(groups[2], "groups[2]").user).toBe("zara");
	});

	test("preserves all blocker details", () => {
		const blockers = [
			makeBlocker({
				user: "carol",
				description: "Security review",
				branch: "feat/auth",
				prNumber: 123,
				prTitle: "Add authentication",
			}),
		];
		const groups = groupBlockersByUser(blockers);

		const first = assertDefined(groups[0], "groups[0]");
		const firstBlocker = assertDefined(first.blockers[0], "blockers[0]");
		expect(firstBlocker).toEqual({
			description: "Security review",
			branch: "feat/auth",
			prNumber: 123,
			prTitle: "Add authentication",
		});
	});

	test("handles mixed blocker counts correctly", () => {
		const blockers = [
			makeBlocker({ user: "alice", description: "A1" }),
			makeBlocker({ user: "bob", description: "B1" }),
			makeBlocker({ user: "alice", description: "A2" }),
			makeBlocker({ user: "carol", description: "C1" }),
			makeBlocker({ user: "bob", description: "B2" }),
			makeBlocker({ user: "bob", description: "B3" }),
		];
		const groups = groupBlockersByUser(blockers);

		expect(groups).toHaveLength(3);
		const g0 = assertDefined(groups[0], "groups[0]");
		const g1 = assertDefined(groups[1], "groups[1]");
		const g2 = assertDefined(groups[2], "groups[2]");
		expect(g0.user).toBe("bob"); // 3 blockers
		expect(g0.blockers).toHaveLength(3);
		expect(g1.user).toBe("alice"); // 2 blockers
		expect(g1.blockers).toHaveLength(2);
		expect(g2.user).toBe("carol"); // 1 blocker
		expect(g2.blockers).toHaveLength(1);
	});
});

// =============================================================================
// detectStaleReviews Tests
// =============================================================================

/**
 * Helper to create a date N days ago.
 */
function daysAgo(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() - days);
	return date.toISOString();
}

/**
 * Helper to create a test PR with blockers.
 */
function makePR(
	prNumber: number,
	blockers: Array<{
		key: string;
		type: string;
		detectedAt: string;
		resolvedAt?: string;
		reviewer?: string;
	}>,
	meta?: { title?: string; repo?: string },
): [number, StaleReviewInput] {
	const blockerMap = new Map<
		string,
		{ type: string; reviewer?: string; detectedAt: string; resolvedAt?: string }
	>();
	for (const b of blockers) {
		blockerMap.set(b.key, {
			type: b.type,
			reviewer: b.reviewer,
			detectedAt: b.detectedAt,
			resolvedAt: b.resolvedAt,
		});
	}
	return [
		prNumber,
		{
			meta: {
				title: meta?.title ?? `PR #${prNumber}`,
				repo: meta?.repo ?? "owner/repo",
			},
			blockers: blockerMap,
		},
	];
}

describe("detectStaleReviews", () => {
	test("returns empty array when no pending_review blockers", () => {
		const openPRs = new Map([
			makePR(1, [
				{ key: "ci_failing", type: "ci_failing", detectedAt: daysAgo(5) },
				{
					key: "blocked_label",
					type: "blocked_label",
					detectedAt: daysAgo(10),
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toEqual([]);
	});

	test("detects reviews pending >= threshold days (default 3)", () => {
		const openPRs = new Map([
			makePR(123, [
				{
					key: "pending:alice",
					type: "pending_review",
					detectedAt: daysAgo(5),
					reviewer: "alice",
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toHaveLength(1);
		expect(result[0]?.prNumber).toBe(123);
		expect(result[0]?.reviewer).toBe("alice");
		expect(result[0]?.reviewerType).toBe("user");
		expect(result[0]?.daysAgo).toBe(5);
	});

	test("excludes reviews pending < threshold days", () => {
		const openPRs = new Map([
			makePR(123, [
				{
					key: "pending:bob",
					type: "pending_review",
					detectedAt: daysAgo(2), // Only 2 days - not stale
					reviewer: "bob",
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toEqual([]);
	});

	test("respects custom threshold parameter", () => {
		const openPRs = new Map([
			makePR(123, [
				{
					key: "pending:carol",
					type: "pending_review",
					detectedAt: daysAgo(5),
					reviewer: "carol",
				},
			]),
		]);

		// With threshold of 7, 5 days is not stale
		const notStale = detectStaleReviews(openPRs, 7);
		expect(notStale).toEqual([]);

		// With threshold of 3, 5 days is stale
		const stale = detectStaleReviews(openPRs, 3);
		expect(stale).toHaveLength(1);
	});

	test("excludes already-resolved blockers", () => {
		const openPRs = new Map([
			makePR(123, [
				{
					key: "pending:dave",
					type: "pending_review",
					detectedAt: daysAgo(10),
					resolvedAt: daysAgo(2), // Resolved 2 days ago
					reviewer: "dave",
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toEqual([]);
	});

	test("detects team reviews with correct reviewerType", () => {
		const openPRs = new Map([
			makePR(456, [
				{
					key: "pending:team:security",
					type: "pending_review",
					detectedAt: daysAgo(7),
					reviewer: "security",
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toHaveLength(1);
		expect(result[0]?.reviewer).toBe("security");
		expect(result[0]?.reviewerType).toBe("team");
	});

	test("sorts by days (oldest first)", () => {
		const openPRs = new Map([
			makePR(1, [
				{
					key: "pending:alice",
					type: "pending_review",
					detectedAt: daysAgo(3),
					reviewer: "alice",
				},
			]),
			makePR(2, [
				{
					key: "pending:bob",
					type: "pending_review",
					detectedAt: daysAgo(10),
					reviewer: "bob",
				},
			]),
			makePR(3, [
				{
					key: "pending:carol",
					type: "pending_review",
					detectedAt: daysAgo(5),
					reviewer: "carol",
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toHaveLength(3);
		expect(result[0]?.daysAgo).toBe(10); // bob - oldest
		expect(result[1]?.daysAgo).toBe(5); // carol
		expect(result[2]?.daysAgo).toBe(3); // alice - newest
	});

	test("handles multiple stale reviews on same PR", () => {
		const openPRs = new Map([
			makePR(
				789,
				[
					{
						key: "pending:alice",
						type: "pending_review",
						detectedAt: daysAgo(4),
						reviewer: "alice",
					},
					{
						key: "pending:team:core",
						type: "pending_review",
						detectedAt: daysAgo(6),
						reviewer: "core",
					},
				],
				{ title: "Big feature", repo: "facebook/react" },
			),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toHaveLength(2);
		expect(result.every((r) => r.prNumber === 789)).toBe(true);
		expect(result.every((r) => r.prTitle === "Big feature")).toBe(true);
		expect(result.every((r) => r.repo === "facebook/react")).toBe(true);
	});

	test("extracts reviewer from key when reviewer property missing", () => {
		const openPRs = new Map([
			makePR(123, [
				{
					key: "pending:extracted-user",
					type: "pending_review",
					detectedAt: daysAgo(5),
					// No reviewer property
				},
			]),
		]);

		const result = detectStaleReviews(openPRs);
		expect(result).toHaveLength(1);
		expect(result[0]?.reviewer).toBe("extracted-user");
	});
});

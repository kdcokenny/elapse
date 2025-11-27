import { describe, expect, test } from "bun:test";
import {
	type BlockerSummary,
	groupBlockersByUser,
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

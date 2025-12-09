import { describe, expect, test } from "bun:test";
import {
	determineRAGStatus,
	formatRAGStatus,
} from "../../src/core/weekly-status";

describe("determineRAGStatus", () => {
	test("returns green when no blockers", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [],
				staleReviews: [],
			}),
		).toBe("green");
	});

	test("returns green with few stale reviews", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [],
				staleReviews: [{ daysWaiting: 5 }, { daysWaiting: 4 }],
			}),
		).toBe("green");
	});

	test("returns yellow with 1-2 recent blockers", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 3 }],
				staleReviews: [],
			}),
		).toBe("yellow");
	});

	test("returns yellow with 2 blockers", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 1 }, { ageDays: 2 }],
				staleReviews: [],
			}),
		).toBe("yellow");
	});

	test("returns yellow with 3+ stale reviews", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [],
				staleReviews: [
					{ daysWaiting: 4 },
					{ daysWaiting: 5 },
					{ daysWaiting: 6 },
				],
			}),
		).toBe("yellow");
	});

	test("returns red when blocker >= 7 days", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 7 }],
				staleReviews: [],
			}),
		).toBe("red");
	});

	test("returns red when blocker > 7 days", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 10 }],
				staleReviews: [],
			}),
		).toBe("red");
	});

	test("returns red when 3+ active blockers", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 1 }, { ageDays: 2 }, { ageDays: 1 }],
				staleReviews: [],
			}),
		).toBe("red");
	});

	test("red takes priority over yellow (old blocker)", () => {
		expect(
			determineRAGStatus({
				activeBlockers: [{ ageDays: 8 }],
				staleReviews: [
					{ daysWaiting: 4 },
					{ daysWaiting: 5 },
					{ daysWaiting: 6 },
				],
			}),
		).toBe("red");
	});
});

describe("formatRAGStatus", () => {
	test("green formats correctly", () => {
		expect(formatRAGStatus("green")).toBe("🟢 On Track");
	});

	test("yellow formats correctly", () => {
		expect(formatRAGStatus("yellow")).toBe("🟡 At Risk");
	});

	test("red formats correctly", () => {
		expect(formatRAGStatus("red")).toBe("🔴 Blocked");
	});
});

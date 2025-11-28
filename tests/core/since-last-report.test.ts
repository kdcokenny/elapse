/**
 * Unit tests for "since last report" temporal coverage feature.
 *
 * Validates:
 * 1. Timestamp storage works correctly
 * 2. Date range filtering includes items since last report
 * 3. Watermark calculation returns max timestamp from data
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
	addPRToDay,
	addPRTranslation,
	createOrUpdatePR,
	getAllPRDataForDate,
	getLastReportTimestamp,
	setLastReportTimestamp,
	setPRStatus,
} from "../../src/redis";
import { getWatermark } from "../../src/reporter";
import { initTestRedis, resetTestRedis, restoreRedis } from "../e2e/test-redis";

describe("Since Last Report", () => {
	beforeAll(() => {
		initTestRedis();
	});

	afterAll(() => {
		restoreRedis();
	});

	beforeEach(async () => {
		await resetTestRedis();
	});

	describe("lastReportTimestamp storage", () => {
		test("getLastReportTimestamp returns null when no timestamp set", async () => {
			const result = await getLastReportTimestamp();
			expect(result).toBeNull();
		});

		test("setLastReportTimestamp stores and retrieves timestamp", async () => {
			const timestamp = "2025-02-24T09:00:00.000Z";
			await setLastReportTimestamp(timestamp);
			const result = await getLastReportTimestamp();
			expect(result).toBe(timestamp);
		});

		test("setLastReportTimestamp overwrites previous value", async () => {
			await setLastReportTimestamp("2025-02-24T09:00:00.000Z");
			await setLastReportTimestamp("2025-02-25T09:00:00.000Z");
			const result = await getLastReportTimestamp();
			expect(result).toBe("2025-02-25T09:00:00.000Z");
		});
	});

	describe("getAllPRDataForDate with sinceTimestamp", () => {
		beforeEach(async () => {
			// Setup: Create PR with translations at different timestamps
			await createOrUpdatePR(101, {
				repo: "test/repo",
				branch: "feature/auth",
				title: "Add authentication",
				authors: ["alice"],
				status: "open",
			});

			// Friday 8am - before report
			await addPRTranslation(101, {
				sha: "abc1",
				summary: "Friday morning work",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-21T08:00:00.000Z",
			});

			// Friday 2pm - after 9am report
			await addPRTranslation(101, {
				sha: "abc2",
				summary: "Friday afternoon work",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-21T14:00:00.000Z",
			});

			// Saturday 10am - weekend work
			await addPRTranslation(101, {
				sha: "abc3",
				summary: "Saturday work",
				category: "feature",
				significance: "medium",
				author: "alice",
				timestamp: "2025-02-22T10:00:00.000Z",
			});

			// Add PR to Friday's day index
			await addPRToDay("2025-02-21", 101);
		});

		test("without sinceTimestamp, returns only that date's translations", async () => {
			const data = await getAllPRDataForDate("2025-02-21");

			const pr = data.openPRs.get(101);
			expect(pr).toBeDefined();
			// Should only include items starting with "2025-02-21"
			expect(pr?.translations.length).toBe(2); // 8am and 2pm
			expect(
				pr?.translations.every((t) => t.timestamp.startsWith("2025-02-21")),
			).toBe(true);
		});

		test("with sinceTimestamp, returns items >= timestamp", async () => {
			// Query since Friday 9am
			const data = await getAllPRDataForDate(
				"2025-02-24",
				"2025-02-21T09:00:00.000Z",
			);

			const pr = data.openPRs.get(101);
			expect(pr).toBeDefined();
			// Should include Friday 2pm and Saturday (not Friday 8am)
			expect(pr?.translations.length).toBe(2);
			expect(
				pr?.translations.some((t) => t.summary === "Friday afternoon work"),
			).toBe(true);
			expect(pr?.translations.some((t) => t.summary === "Saturday work")).toBe(
				true,
			);
			expect(
				pr?.translations.some((t) => t.summary === "Friday morning work"),
			).toBe(false);
		});

		test("merged PRs included when mergedAt >= sinceTimestamp", async () => {
			// Create a PR merged on Saturday
			await createOrUpdatePR(102, {
				repo: "test/repo",
				branch: "fix/bug",
				title: "Fix critical bug",
				authors: ["bob"],
				status: "open",
			});

			await addPRTranslation(102, {
				sha: "def1",
				summary: "Bug fix",
				category: "fix",
				significance: "high",
				author: "bob",
				timestamp: "2025-02-22T11:00:00.000Z",
			});

			// Mark as merged on Saturday
			await setPRStatus(102, "merged", "2025-02-22T12:00:00.000Z");
			await addPRToDay("2025-02-22", 102);

			// Query since Friday 9am (should include Saturday merged PR)
			const data = await getAllPRDataForDate(
				"2025-02-24",
				"2025-02-21T09:00:00.000Z",
			);

			expect(data.mergedPRs.has(102)).toBe(true);
			const mergedPR = data.mergedPRs.get(102);
			expect(mergedPR?.meta.title).toBe("Fix critical bug");
		});

		test("merged PRs excluded when mergedAt < sinceTimestamp", async () => {
			// Create a PR merged on Thursday (before Friday 9am)
			await createOrUpdatePR(103, {
				repo: "test/repo",
				branch: "fix/old",
				title: "Old fix",
				authors: ["carol"],
				status: "open",
			});

			await addPRTranslation(103, {
				sha: "ghi1",
				summary: "Old bug fix",
				category: "fix",
				significance: "low",
				author: "carol",
				timestamp: "2025-02-20T15:00:00.000Z",
			});

			// Mark as merged on Thursday
			await setPRStatus(103, "merged", "2025-02-20T16:00:00.000Z");
			await addPRToDay("2025-02-20", 103);

			// Query since Friday 9am (should NOT include Thursday merged PR)
			const data = await getAllPRDataForDate(
				"2025-02-24",
				"2025-02-21T09:00:00.000Z",
			);

			expect(data.mergedPRs.has(103)).toBe(false);
		});
	});

	describe("getWatermark", () => {
		test("returns max timestamp from merged PRs", () => {
			const data = {
				mergedPRs: new Map([
					[
						101,
						{
							meta: {
								repo: "test/repo",
								branch: "feature/a",
								title: "Feature A",
								authors: ["alice"],
								status: "merged" as const,
								openedAt: "2025-02-20T10:00:00.000Z",
								mergedAt: "2025-02-24T17:00:00.000Z",
							},
							translations: [],
							blockers: new Map(),
							hasActivityToday: true,
							blockersResolved: [],
						},
					],
				]),
				openPRs: new Map(),
			};

			expect(getWatermark(data)).toBe("2025-02-24T17:00:00.000Z");
		});

		test("returns max timestamp from open PR translations", () => {
			const data = {
				mergedPRs: new Map(),
				openPRs: new Map([
					[
						101,
						{
							meta: {
								repo: "test/repo",
								branch: "feature/a",
								title: "Feature A",
								authors: ["alice"],
								status: "open" as const,
								openedAt: "2025-02-20T10:00:00.000Z",
							},
							translations: [
								{
									sha: "abc1",
									summary: "First commit",
									category: "feature",
									significance: "medium",
									author: "alice",
									timestamp: "2025-02-24T10:00:00.000Z",
								},
								{
									sha: "abc2",
									summary: "Second commit",
									category: "feature",
									significance: "medium",
									author: "alice",
									timestamp: "2025-02-24T15:00:00.000Z",
								},
							],
							blockers: new Map(),
							hasActivityToday: true,
						},
					],
				]),
			};

			expect(getWatermark(data)).toBe("2025-02-24T15:00:00.000Z");
		});

		test("returns max across merged and open PRs", () => {
			const data = {
				mergedPRs: new Map([
					[
						101,
						{
							meta: {
								repo: "test/repo",
								branch: "feature/a",
								title: "Feature A",
								authors: ["alice"],
								status: "merged" as const,
								openedAt: "2025-02-20T10:00:00.000Z",
								mergedAt: "2025-02-24T14:00:00.000Z",
							},
							translations: [
								{
									sha: "abc1",
									summary: "Merged commit",
									category: "feature",
									significance: "medium",
									author: "alice",
									timestamp: "2025-02-24T13:00:00.000Z",
								},
							],
							blockers: new Map(),
							hasActivityToday: true,
							blockersResolved: [],
						},
					],
				]),
				openPRs: new Map([
					[
						102,
						{
							meta: {
								repo: "test/repo",
								branch: "feature/b",
								title: "Feature B",
								authors: ["bob"],
								status: "open" as const,
								openedAt: "2025-02-20T10:00:00.000Z",
							},
							translations: [
								{
									sha: "def1",
									summary: "Open commit",
									category: "feature",
									significance: "medium",
									author: "bob",
									timestamp: "2025-02-24T16:00:00.000Z", // Latest
								},
							],
							blockers: new Map(),
							hasActivityToday: true,
						},
					],
				]),
			};

			expect(getWatermark(data)).toBe("2025-02-24T16:00:00.000Z");
		});

		test("returns current time when no data", () => {
			const data = {
				mergedPRs: new Map(),
				openPRs: new Map(),
			};

			const before = new Date().toISOString();
			const watermark = getWatermark(data);
			const after = new Date().toISOString();

			// Should be approximately now
			expect(watermark >= before).toBe(true);
			expect(watermark <= after).toBe(true);
		});
	});
});

/**
 * Unit tests for "since last report" watermark calculation.
 *
 * Tests the pure `getWatermark()` function that calculates the max timestamp
 * from PR data. Redis storage tests are in e2e/since-last-report.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { getWatermark } from "../../src/core/watermark";

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

/**
 * Unit tests for Discord message chunking functionality.
 */

import { describe, expect, test } from "bun:test";
import {
	type DailyHybridData,
	formatDailyThreadContent,
	formatWeeklyThreadContent,
	type WeeklyHybridData,
} from "../../src/core/formatting";
import { splitIntoChunks } from "../../src/discord";

describe("splitIntoChunks", () => {
	const MAX_LENGTH = 1900;

	test("returns empty array for empty content", () => {
		expect(splitIntoChunks("", MAX_LENGTH)).toEqual([]);
	});

	test("returns single chunk for short content", () => {
		const content = "Hello, world!";
		const chunks = splitIntoChunks(content, MAX_LENGTH);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(content);
	});

	test("returns single chunk for content at exactly max length", () => {
		const content = "x".repeat(MAX_LENGTH);
		const chunks = splitIntoChunks(content, MAX_LENGTH);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe(content);
	});

	test("splits content on newline boundaries", () => {
		const line1 = "Line 1 content";
		const line2 = "Line 2 content";
		const line3 = "Line 3 content";
		const content = `${line1}\n${line2}\n${line3}`;

		// Use a small max length that forces splitting
		const chunks = splitIntoChunks(content, 20);

		expect(chunks.length).toBeGreaterThan(1);
		// Each chunk should be under the limit
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(20);
		}
	});

	test("preserves markdown formatting across chunks", () => {
		const content = [
			"**BLOCKERS**",
			"",
			"* alice: Waiting for review",
			"  - PR #101",
			"",
			"**SHIPPED**",
			"",
			"* Payment Flow",
			"  - Stripe integration",
		].join("\n");

		const chunks = splitIntoChunks(content, 50);

		// Verify all content is preserved
		const rejoined = chunks.join("\n");
		expect(rejoined).toContain("**BLOCKERS**");
		expect(rejoined).toContain("**SHIPPED**");
		expect(rejoined).toContain("Stripe integration");
	});

	test("handles single long line by putting it in own chunk", () => {
		const longLine = "x".repeat(100);
		const shortLine = "short";
		const content = `${shortLine}\n${longLine}\n${shortLine}`;

		const chunks = splitIntoChunks(content, 50);

		// Long line should be in its own chunk
		expect(chunks.some((c) => c.includes(longLine))).toBe(true);
		// Short lines should be preserved
		const rejoined = chunks.join("\n");
		expect(rejoined.match(/short/g)?.length).toBe(2);
	});

	test("trims whitespace from chunks", () => {
		const content = "  Line 1  \n  Line 2  \n  Line 3  ";
		const chunks = splitIntoChunks(content, 15);

		for (const chunk of chunks) {
			expect(chunk).toBe(chunk.trim());
		}
	});

	test("handles content with only newlines", () => {
		const content = "\n\n\n";
		const chunks = splitIntoChunks(content, MAX_LENGTH);

		// Should result in empty array since all lines are empty
		expect(chunks).toEqual([]);
	});

	describe("realistic content", () => {
		test("chunks realistic daily report correctly", () => {
			const data: DailyHybridData = {
				date: "2025-02-24",
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 2,
						oldestAge: "6 days",
						blockers: [
							{
								description: "Waiting for security review from external team",
								branch: "feature/auth",
								prNumber: 101,
								prTitle: "Add OAuth2 authentication flow",
								repo: "test/repo",
								age: "6 days",
							},
							{
								description: "Need API keys from finance department",
								branch: "feature/payment",
								prNumber: 102,
								prTitle: "Stripe integration",
								repo: "test/repo",
								age: "3 days",
							},
						],
					},
					{
						user: "bob",
						blockerCount: 1,
						oldestAge: "2 days",
						blockers: [
							{
								description: "Blocked by failing CI tests",
								branch: "feature/dashboard",
								prNumber: 103,
								prTitle: "Dashboard redesign",
								repo: "test/repo",
								age: "2 days",
							},
						],
					},
				],
				shipped: [
					{
						featureName: "User Authentication Flow",
						impact: "Users can now sign in with OAuth2 providers",
						prNumber: 100,
						authors: ["alice", "carol"],
						commitCount: 15,
						repo: "test/repo",
					},
					{
						featureName: "Payment Processing",
						impact: "Stripe payments now supported for subscriptions",
						prNumber: 99,
						authors: ["bob"],
						commitCount: 8,
						repo: "test/repo",
					},
				],
				progress: [
					{
						branch: "feature/analytics",
						users: ["carol", "dave"],
						commitCount: 12,
						prNumber: 104,
						prTitle: "Analytics dashboard",
						featureName: "Analytics Dashboard",
						impact: "Real-time metrics visualization",
						repo: "test/repo",
					},
				],
				staleReviews: [
					{
						prNumber: 105,
						prTitle: "Fix mobile responsiveness",
						reviewer: "eve",
						daysAgo: 5,
						repo: "test/repo",
					},
				],
				stats: {
					prsMerged: 2,
					branchesActive: 3,
					totalCommits: 35,
					blockerCount: 3,
					staleReviewCount: 1,
					oldestBlockerAge: "6 days",
				},
			};

			const content = formatDailyThreadContent(data);
			const chunks = splitIntoChunks(content, MAX_LENGTH);

			// All chunks should be under the limit
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(MAX_LENGTH);
			}

			// All content should be preserved when rejoined
			const rejoined = chunks.join("\n");
			expect(rejoined).toContain("BLOCKERS");
			expect(rejoined).toContain("alice");
			expect(rejoined).toContain("bob");
			expect(rejoined).toContain("SHIPPED TODAY");
			expect(rejoined).toContain("User Authentication Flow");
			expect(rejoined).toContain("IN PROGRESS");
			expect(rejoined).toContain("AWAITING REVIEW");
		});

		test("chunks realistic weekly report correctly", () => {
			const data: WeeklyHybridData = {
				weekOf: new Date("2025-02-24"),
				ragStatus: "yellow",
				summary: {
					executiveSummary:
						"Good progress on auth and payments, but blocked on security review.",
					shippedGroups: [
						{
							theme: "Authentication",
							summary: "OAuth2 login flow with Google and GitHub providers",
							contributors: ["alice", "bob", "carol"],
						},
						{
							theme: "Payments",
							summary: "Stripe subscription billing and invoice generation",
							contributors: ["dave", "eve"],
						},
						{
							theme: "Infrastructure",
							summary: "Migrated to new CI/CD pipeline with 50% faster builds",
							contributors: ["frank"],
						},
					],
					blockersAndRisks:
						"Security review pending 6 days - need @security-team sign-off before launch",
					helpNeeded:
						"Need executive escalation on vendor contract for third-party API access",
					nextWeek:
						"Complete payment integration and begin mobile app development",
				},
				stats: {
					totalMerged: 12,
					blockersResolved: 3,
					activeBlockerCount: 2,
					staleReviewCount: 1,
					inProgressCount: 4,
					contributorCount: 6,
				},
			};

			const content = formatWeeklyThreadContent(data);
			const chunks = splitIntoChunks(content, MAX_LENGTH);

			// All chunks should be under the limit
			for (const chunk of chunks) {
				expect(chunk.length).toBeLessThanOrEqual(MAX_LENGTH);
			}

			// All content should be preserved when rejoined
			const rejoined = chunks.join("\n");
			expect(rejoined).toContain("SHIPPED THIS WEEK");
			expect(rejoined).toContain("Authentication");
			expect(rejoined).toContain("Payments");
			expect(rejoined).toContain("BLOCKERS & RISKS");
			expect(rejoined).toContain("HELP NEEDED");
			expect(rejoined).toContain("CARRYING INTO NEXT WEEK");
		});
	});
});

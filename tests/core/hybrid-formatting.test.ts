/**
 * Unit tests for hybrid thread formatting functions.
 */

import { describe, expect, test } from "bun:test";
import {
	type DailyHybridData,
	formatDailyMainEmbed,
	formatDailyThreadContent,
	formatWeeklyMainEmbed,
	formatWeeklyThreadContent,
	getThreadName,
	type WeeklyHybridData,
} from "../../src/core/formatting";
import { RAG_COLORS } from "../../src/discord";

describe("Hybrid Formatting", () => {
	describe("Daily Main Embed", () => {
		const baseDailyData: DailyHybridData = {
			date: "2025-02-24",
			blockerGroups: [],
			shipped: [],
			progress: [],
			staleReviews: [],
			stats: {
				prsMerged: 0,
				branchesActive: 0,
				totalCommits: 0,
				blockerCount: 0,
				staleReviewCount: 0,
			},
		};

		test("should format empty day with green status", () => {
			const embed = formatDailyMainEmbed(baseDailyData);

			expect(embed.title).toContain("Daily Summary");
			expect(embed.title).toContain("Feb 24");
			expect(embed.color).toBe(RAG_COLORS.green);
			expect(embed.footer?.text).toContain("thread");
		});

		test("should show yellow status with blockers", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						oldestAge: "2 days",
						blockers: [
							{
								description: "Waiting for API keys",
								branch: "feature/auth",
								age: "2 days",
							},
						],
					},
				],
				stats: { ...baseDailyData.stats, blockerCount: 1 },
			};

			const embed = formatDailyMainEmbed(data);

			expect(embed.color).toBe(RAG_COLORS.yellow);
			expect(embed.description).toContain("1 blocker");
		});

		test("should show red status with old blocker (5+ days)", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						oldestAge: "6 days",
						blockers: [
							{
								description: "Security review needed",
								branch: "feature/auth",
								age: "6 days",
							},
						],
					},
				],
				stats: {
					...baseDailyData.stats,
					blockerCount: 1,
					oldestBlockerAge: "6 days",
				},
			};

			const embed = formatDailyMainEmbed(data);

			expect(embed.color).toBe(RAG_COLORS.red);
			// Should have ESCALATION field
			const escalationField = embed.fields?.find((f) =>
				f.name.includes("ESCALATION"),
			);
			expect(escalationField).toBeDefined();
			expect(escalationField?.value).toContain("Security review");
		});

		test("should include shipped and progress counts in fields", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				shipped: [
					{
						featureName: "Auth Flow",
						impact: "Secure login",
						prNumber: 101,
						authors: ["alice"],
						commitCount: 3,
						repo: "test/repo",
					},
				],
				progress: [
					{
						branch: "feature/payment",
						users: ["bob"],
						commitCount: 2,
					},
				],
				stats: {
					...baseDailyData.stats,
					prsMerged: 1,
					branchesActive: 1,
				},
			};

			const embed = formatDailyMainEmbed(data);

			const shippedField = embed.fields?.find((f) =>
				f.name.includes("Shipped"),
			);
			expect(shippedField).toBeDefined();
			expect(shippedField?.value).toBe("1 PR");

			const progressField = embed.fields?.find((f) =>
				f.name.includes("Progress"),
			);
			expect(progressField).toBeDefined();
			expect(progressField?.value).toBe("1 feature");
		});

		test("should keep description under 400 chars", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				shipped: Array(20)
					.fill(null)
					.map((_, i) => ({
						featureName: `Feature ${i}`,
						impact: "Some impact description that is moderately long",
						prNumber: 100 + i,
						authors: ["alice", "bob"],
						commitCount: 5,
						repo: "test/repo",
					})),
				stats: { ...baseDailyData.stats, prsMerged: 20 },
			};

			const embed = formatDailyMainEmbed(data);

			expect(embed.description?.length).toBeLessThanOrEqual(400);
		});
	});

	describe("Weekly Main Embed", () => {
		const baseWeeklyData: WeeklyHybridData = {
			weekOf: new Date("2025-02-24"),
			ragStatus: "green",
			summary: {
				executiveSummary: "Productive week with auth and payments shipped.",
				shippedGroups: [],
				blockersAndRisks: null,
				helpNeeded: null,
			},
			stats: {
				totalMerged: 0,
				blockersResolved: 0,
				activeBlockerCount: 0,
				staleReviewCount: 0,
				inProgressCount: 0,
				contributorCount: 0,
			},
		};

		test("should format green status week", () => {
			const embed = formatWeeklyMainEmbed(baseWeeklyData);

			expect(embed.title).toContain("Weekly Summary");
			expect(embed.title).toContain("Feb 24");
			expect(embed.color).toBe(RAG_COLORS.green);
			expect(embed.description).toContain("On Track");
		});

		test("should format yellow status week", () => {
			const data: WeeklyHybridData = {
				...baseWeeklyData,
				ragStatus: "yellow",
				stats: { ...baseWeeklyData.stats, activeBlockerCount: 1 },
			};

			const embed = formatWeeklyMainEmbed(data);

			expect(embed.color).toBe(RAG_COLORS.yellow);
			expect(embed.description).toContain("At Risk");
		});

		test("should format red status with escalation", () => {
			const data: WeeklyHybridData = {
				...baseWeeklyData,
				ragStatus: "red",
				stats: { ...baseWeeklyData.stats, activeBlockerCount: 2 },
				activeBlockers: [
					{
						description: "Security review blocked",
						owner: "eve",
						ageDays: 7,
					},
					{
						description: "API keys missing",
						owner: "finance",
						ageDays: 5,
					},
				],
			};

			const embed = formatWeeklyMainEmbed(data);

			expect(embed.color).toBe(RAG_COLORS.red);
			expect(embed.description).toContain("Blocked");

			const escalationField = embed.fields?.find((f) =>
				f.name.includes("ESCALATION"),
			);
			expect(escalationField).toBeDefined();
			expect(escalationField?.value).toContain("Security review");
			expect(escalationField?.value).toContain("+1 more");
		});

		test("should include stats fields", () => {
			const data: WeeklyHybridData = {
				...baseWeeklyData,
				stats: {
					...baseWeeklyData.stats,
					totalMerged: 5,
					inProgressCount: 3,
				},
			};

			const embed = formatWeeklyMainEmbed(data);

			const shippedField = embed.fields?.find((f) =>
				f.name.includes("Shipped"),
			);
			expect(shippedField?.value).toBe("5 PRs");

			const progressField = embed.fields?.find((f) =>
				f.name.includes("Progress"),
			);
			expect(progressField?.value).toBe("3");
		});
	});

	describe("Daily Thread Content", () => {
		test("should format complete daily thread", () => {
			const data: DailyHybridData = {
				date: "2025-02-24",
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						blockers: [
							{
								description: "Waiting for review",
								branch: "feature/auth",
								prNumber: 101,
								prTitle: "Add auth",
								repo: "test/repo",
								age: "2 days",
							},
						],
					},
				],
				shipped: [
					{
						featureName: "Payment Flow",
						impact: "Stripe integration",
						prNumber: 100,
						authors: ["bob"],
						commitCount: 5,
						repo: "test/repo",
					},
				],
				progress: [
					{
						branch: "feature/dashboard",
						users: ["carol"],
						commitCount: 3,
						prNumber: 102,
						prTitle: "Dashboard redesign",
						featureName: "Dashboard Redesign",
						impact: "Better UX",
						repo: "test/repo",
					},
				],
				staleReviews: [
					{
						prNumber: 103,
						prTitle: "Fix bug",
						reviewer: "dave",
						daysAgo: 4,
						repo: "test/repo",
					},
				],
				stats: {
					prsMerged: 1,
					branchesActive: 1,
					totalCommits: 8,
					blockerCount: 1,
					staleReviewCount: 1,
					oldestBlockerAge: "2 days",
				},
			};

			const content = formatDailyThreadContent(data);

			// Check sections exist
			expect(content).toContain("BLOCKERS");
			expect(content).toContain("Waiting for review");
			expect(content).toContain("AWAITING REVIEW");
			expect(content).toContain("@dave");
			expect(content).toContain("SHIPPED TODAY");
			expect(content).toContain("Payment Flow");
			expect(content).toContain("IN PROGRESS");
			expect(content).toContain("Dashboard Redesign");

			// Check PR links
			expect(content).toContain("PR #101");
			expect(content).toContain("github.com/test/repo/pull/100");
		});
	});

	describe("Weekly Thread Content", () => {
		test("should format complete weekly thread", () => {
			const data: WeeklyHybridData = {
				weekOf: new Date("2025-02-24"),
				ragStatus: "yellow",
				summary: {
					executiveSummary: "Good progress despite blocker.",
					shippedGroups: [
						{
							theme: "Authentication",
							summary: "OAuth2 login flow",
							contributors: ["alice", "bob"],
						},
					],
					blockersAndRisks: "Security review pending 3 days",
					helpNeeded: "Need @eve for security sign-off",
					nextWeek: "Complete payment integration",
				},
				stats: {
					totalMerged: 4,
					blockersResolved: 1,
					activeBlockerCount: 1,
					staleReviewCount: 0,
					inProgressCount: 2,
					contributorCount: 3,
				},
			};

			const content = formatWeeklyThreadContent(data);

			// Check sections
			expect(content).toContain("SHIPPED THIS WEEK");
			expect(content).toContain("Authentication");
			expect(content).toContain("alice, bob");
			expect(content).toContain("BLOCKERS & RISKS");
			expect(content).toContain("Security review pending");
			expect(content).toContain("HELP NEEDED");
			expect(content).toContain("@eve");
			expect(content).toContain("CARRYING INTO NEXT WEEK");
			expect(content).toContain("payment integration");

			// Check stats footer
			expect(content).toContain("4 PRs merged");
			expect(content).toContain("1 blocker");
		});

		test("should handle empty sections gracefully", () => {
			const data: WeeklyHybridData = {
				weekOf: new Date("2025-02-24"),
				ragStatus: "green",
				summary: {
					executiveSummary: "Quiet week.",
					shippedGroups: [],
					blockersAndRisks: null,
					helpNeeded: null,
				},
				stats: {
					totalMerged: 0,
					blockersResolved: 0,
					activeBlockerCount: 0,
					staleReviewCount: 0,
					inProgressCount: 0,
					contributorCount: 0,
				},
			};

			const content = formatWeeklyThreadContent(data);

			expect(content).toContain("None active");
			expect(content).toContain("None this week");
			expect(content).not.toContain("SHIPPED THIS WEEK");
			expect(content).not.toContain("CARRYING INTO NEXT WEEK");
		});
	});

	describe("Help Needed Section", () => {
		const baseDailyData: DailyHybridData = {
			date: "2025-02-24",
			blockerGroups: [],
			shipped: [],
			progress: [],
			staleReviews: [],
			stats: {
				prsMerged: 0,
				branchesActive: 0,
				totalCommits: 0,
				blockerCount: 0,
				staleReviewCount: 0,
			},
		};

		test("should show Help Needed for blockers > 5 days old", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						oldestAge: "6 days",
						blockers: [
							{
								description: "Need code review",
								branch: "feature/auth",
								prNumber: 101,
								prTitle: "Add auth",
								repo: "test/repo",
								age: "6 days",
							},
						],
					},
				],
				stats: { ...baseDailyData.stats, blockerCount: 1 },
			};

			const content = formatDailyThreadContent(data);

			expect(content).toContain("🙋 **HELP NEEDED**");
			expect(content).toContain("Need code review (6 days) — @alice");
			expect(content).toContain("PR #101");
		});

		test("should show Help Needed for blockers with escalation keywords", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "carol",
						blockerCount: 1,
						oldestAge: "2 days",
						blockers: [
							{
								description: "Waiting for API keys from finance team",
								branch: "feature/payment",
								prNumber: 201,
								prTitle: "Add payment",
								repo: "test/repo",
								age: "2 days",
							},
						],
					},
				],
				stats: { ...baseDailyData.stats, blockerCount: 1 },
			};

			const content = formatDailyThreadContent(data);

			// Should appear in Help Needed due to "waiting for" + "finance" keywords
			expect(content).toContain("🙋 **HELP NEEDED**");
			expect(content).toContain("Waiting for API keys from finance team");
			expect(content).toContain("@carol");
		});

		test("should NOT show Help Needed for fresh technical blockers", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "bob",
						blockerCount: 1,
						oldestAge: "1 day",
						blockers: [
							{
								description: "Tests failing on CI",
								branch: "feature/tests",
								prNumber: 301,
								age: "1 day",
							},
						],
					},
				],
				stats: { ...baseDailyData.stats, blockerCount: 1 },
			};

			const content = formatDailyThreadContent(data);

			// Should have BLOCKERS but NOT Help Needed
			expect(content).toContain("🔴 **BLOCKERS**");
			expect(content).toContain("Tests failing on CI");
			expect(content).not.toContain("🙋 **HELP NEEDED**");
		});

		test("should omit Help Needed section when empty", () => {
			const content = formatDailyThreadContent(baseDailyData);

			expect(content).not.toContain("HELP NEEDED");
		});

		test("should show Help Needed count in embed", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "carol",
						blockerCount: 2,
						oldestAge: "8 days",
						blockers: [
							{
								description: "Waiting for legal approval",
								branch: "feature/terms",
								prNumber: 401,
								repo: "test/repo",
								age: "8 days",
							},
							{
								description: "Blocked by vendor response",
								branch: "feature/integration",
								prNumber: 402,
								repo: "test/repo",
								age: "6 days",
							},
						],
					},
				],
				stats: {
					...baseDailyData.stats,
					blockerCount: 2,
					oldestBlockerAge: "8 days",
				},
			};

			const embed = formatDailyMainEmbed(data);

			const helpField = embed.fields?.find((f) => f.name.includes("Help"));
			expect(helpField).toBeDefined();
			expect(helpField?.value).toBe("2 escalations");
		});

		test("should NOT show Help Needed field in embed when no escalations", () => {
			const data: DailyHybridData = {
				...baseDailyData,
				blockerGroups: [
					{
						user: "bob",
						blockerCount: 1,
						oldestAge: "1 day",
						blockers: [
							{
								description: "Merge conflict",
								branch: "feature/fix",
								age: "1 day",
							},
						],
					},
				],
				stats: { ...baseDailyData.stats, blockerCount: 1 },
			};

			const embed = formatDailyMainEmbed(data);

			const helpField = embed.fields?.find((f) => f.name.includes("Help"));
			expect(helpField).toBeUndefined();
		});
	});

	describe("Stats Formatting", () => {
		test("should omit 'oldest: today' in stats line", () => {
			const data: DailyHybridData = {
				date: "2025-02-24",
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						oldestAge: "today",
						blockers: [
							{
								description: "New blocker",
								branch: "feature/x",
								age: "today",
							},
						],
					},
				],
				shipped: [],
				progress: [],
				staleReviews: [],
				stats: {
					prsMerged: 0,
					branchesActive: 0,
					totalCommits: 0,
					blockerCount: 1,
					staleReviewCount: 0,
					oldestBlockerAge: "today",
				},
			};

			const content = formatDailyThreadContent(data);

			// Should show "1 blocker" but NOT "oldest: today"
			expect(content).toContain("1 blocker");
			expect(content).not.toContain("oldest: today");
		});

		test("should show 'oldest: X days' when blockers are older", () => {
			const data: DailyHybridData = {
				date: "2025-02-24",
				blockerGroups: [
					{
						user: "alice",
						blockerCount: 1,
						oldestAge: "3 days",
						blockers: [
							{
								description: "Old blocker",
								branch: "feature/x",
								age: "3 days",
							},
						],
					},
				],
				shipped: [],
				progress: [],
				staleReviews: [],
				stats: {
					prsMerged: 0,
					branchesActive: 0,
					totalCommits: 0,
					blockerCount: 1,
					staleReviewCount: 0,
					oldestBlockerAge: "3 days",
				},
			};

			const content = formatDailyThreadContent(data);

			expect(content).toContain("1 blocker (oldest: 3 days)");
		});
	});

	describe("Thread Naming", () => {
		test("should format daily thread name", () => {
			const name = getThreadName("daily", "2025-02-24");

			expect(name).toBe("🚀 Feb 24 — Details");
		});

		test("should format weekly thread name", () => {
			const name = getThreadName("weekly", new Date("2025-02-24"));

			expect(name).toBe("📊 Week of Feb 24 — Details");
		});

		test("should handle Date object for daily", () => {
			const name = getThreadName("daily", new Date("2025-12-16"));

			expect(name).toBe("🚀 Dec 16 — Details");
		});
	});
});

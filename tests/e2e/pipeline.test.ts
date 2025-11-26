/**
 * Full E2E pipeline tests with real AI calls.
 * Tests the complete flow: fixture → translate → store → narrate → report
 *
 * These tests make actual AI API calls and require:
 * - GOOGLE_GENERATIVE_AI_API_KEY
 * - LLM_MODEL_NAME
 * - REDIS_URL (or localhost default)
 *
 * Run with: bun run e2e:test
 */

import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { narrateDay, translateDiff } from "../../src/ai";
import { formatDailyReport, type UserSummary } from "../../src/core/formatting";
import {
	assertFixturesExist,
	cleanupTestContext,
	createTestContext,
	findTestableCommit,
	getAllTestTranslationsForDate,
	runFullPipeline,
	shouldSkipPipelineTest,
	storeTestTranslation,
	type TestContext,
} from "./setup";

// Skip tests if required env vars are missing
const hasRequiredEnv =
	process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.LLM_MODEL_NAME;

describe("E2E Pipeline Tests", () => {
	let ctx: TestContext;

	beforeAll(() => {
		if (!hasRequiredEnv) {
			console.warn(
				"Skipping E2E pipeline tests: Missing GOOGLE_GENERATIVE_AI_API_KEY or LLM_MODEL_NAME",
			);
			return;
		}

		try {
			assertFixturesExist();
		} catch {
			console.warn(
				"Skipping E2E pipeline tests: No fixtures found. Run 'bun run e2e:collect' first.",
			);
			return;
		}

		ctx = createTestContext();
	});

	afterAll(async () => {
		if (ctx) {
			await cleanupTestContext(ctx);
		}
	});

	describe("Translation Tests", () => {
		it("should translate a commit diff successfully", async () => {
			if (!hasRequiredEnv) return;

			const result = findTestableCommit();
			expect(result).not.toBeNull();
			if (!result) return;

			const { commit: testCommit } = result;

			const translation = await translateDiff(
				testCommit.message,
				testCommit.diff,
			);

			// Structural assertions (AI output is non-deterministic)
			expect(translation).toBeTruthy();
			expect(translation.length).toBeGreaterThan(10);
			expect(translation).not.toBe("SKIP");

			console.log(`\nSample translation for ${testCommit.sha.slice(0, 7)}:`);
			console.log(`  Message: ${testCommit.message.split("\n")[0]}`);
			console.log(`  Translation: ${translation}`);
		}, 60000); // 60s timeout for AI call

		it("should handle empty diffs gracefully", async () => {
			if (!hasRequiredEnv) return;

			// translateDiff should handle empty diff without crashing
			const translation = await translateDiff("Empty commit", "");

			// May return a short message or SKIP
			expect(translation).toBeDefined();
		}, 30000);
	});

	describe("Narration Tests", () => {
		it("should narrate multiple translations into a summary", async () => {
			if (!hasRequiredEnv) return;

			const translations = [
				"Added user authentication with JWT tokens for secure API access.",
				"Fixed a bug in the payment processing that caused duplicate charges.",
				"Improved dashboard loading performance by implementing lazy loading.",
			];

			const narrative = await narrateDay(translations, "2025-02-03");

			expect(narrative).toBeTruthy();
			expect(narrative.length).toBeGreaterThan(20);

			console.log(`\nSample narrative:`);
			console.log(narrative);
		}, 60000);

		it("should return single translation without AI when only one", async () => {
			if (!hasRequiredEnv) return;

			const singleTranslation = "Added a new feature for user profiles.";
			const translations = [singleTranslation];
			const narrative = await narrateDay(translations, "2025-02-03");

			// Should return the single translation directly
			expect(narrative).toBe(singleTranslation);
		});

		it("should handle empty translations", async () => {
			if (!hasRequiredEnv) return;

			const narrative = await narrateDay([], "2025-02-03");
			expect(narrative).toBe("No significant updates today.");
		});
	});

	describe("Full Pipeline - Single Repo (excalidraw)", () => {
		it("should process excalidraw fixture through full pipeline", async () => {
			if (shouldSkipPipelineTest(ctx)) return;

			const result = await runFullPipeline({
				ctx,
				repoName: "excalidraw",
			});
			if (!result) return;

			console.log(
				`\n=== Generated Report ===\n${result.report}\n========================\n`,
			);

			expect(result.report).toContain("# Daily Standup");
			expect(result.report.length).toBeGreaterThan(50);

			for (const summary of result.userSummaries) {
				expect(result.report).toContain(summary.user);
			}
		}, 120000);
	});

	describe("Full Pipeline - Supabase Commit Volume Tests", () => {
		// Volume test cases for parameterized testing
		const volumeTestCases = [
			{ name: "HIGH", date: "2025-11-25" },
			{ name: "MEDIUM", date: "2025-11-20" },
			{ name: "LOW", date: "2025-11-22" },
		];

		test.each(
			volumeTestCases,
		)("$name volume ($date): should process commits", async ({
			name,
			date,
		}) => {
			if (shouldSkipPipelineTest(ctx)) return;

			const result = await runFullPipeline({
				ctx,
				repoName: "supabase",
				dateOverride: date,
			});
			if (!result) return;

			console.log(`\n=== ${name} VOLUME (${result.translated} translated) ===`);
			console.log(result.report);
			console.log("=".repeat(50));

			expect(result.report).toContain("# Daily Standup");
			expect(result.userSummaries.length).toBeGreaterThan(0);
		}, 300000); // Max timeout for all

		it("should process supabase fixture through full pipeline", async () => {
			if (shouldSkipPipelineTest(ctx)) return;

			const result = await runFullPipeline({
				ctx,
				repoName: "supabase",
			});
			if (!result) return;

			console.log(
				`\n=== Generated Report (Supabase) ===\n${result.report}\n===================================\n`,
			);

			expect(result.report).toContain("# Daily Standup");

			if (result.userSummaries.length > 1) {
				expect(result.report).toContain("---");
			}
		}, 180000);
	});

	describe("Redis Storage Tests", () => {
		it("should store and retrieve translations correctly", async () => {
			if (!ctx) return;

			const testDate = "2025-02-03-storage-test";
			const testUser = "test-user";
			const testTranslations = [
				"First translation",
				"Second translation",
				"Third translation",
			];

			// Store translations
			for (const t of testTranslations) {
				await storeTestTranslation(ctx, testDate, testUser, t);
			}

			// Retrieve translations
			const retrieved = await getAllTestTranslationsForDate(ctx, testDate);

			expect(retrieved.has(testUser)).toBe(true);
			expect(retrieved.get(testUser)).toEqual(testTranslations);
		});

		it("should not store SKIP translations", async () => {
			if (!ctx) return;

			const testDate = "2025-02-03-skip-test";
			const testUser = "skip-user";

			await storeTestTranslation(ctx, testDate, testUser, "SKIP");

			const retrieved = await getAllTestTranslationsForDate(ctx, testDate);

			// User should not have any translations
			expect(retrieved.has(testUser)).toBe(false);
		});

		it("should isolate test data with unique prefixes", async () => {
			if (!ctx) return;

			// Create a second test context
			const ctx2 = createTestContext();

			const testDate = "2025-02-03-isolation-test";
			const testUser = "isolation-user";

			// Store in first context
			await storeTestTranslation(
				ctx,
				testDate,
				testUser,
				"Context 1 translation",
			);

			// Store in second context
			await storeTestTranslation(
				ctx2,
				testDate,
				testUser,
				"Context 2 translation",
			);

			// Retrieve from each context
			const fromCtx1 = await getAllTestTranslationsForDate(ctx, testDate);
			const fromCtx2 = await getAllTestTranslationsForDate(ctx2, testDate);

			// Each should only see their own data
			expect(fromCtx1.get(testUser)).toEqual(["Context 1 translation"]);
			expect(fromCtx2.get(testUser)).toEqual(["Context 2 translation"]);

			// Cleanup second context
			await cleanupTestContext(ctx2);
		});
	});

	describe("Report Formatting Tests", () => {
		it("should format a complete daily report", () => {
			const userSummaries: UserSummary[] = [
				{
					user: "alice",
					narrative: "Fixed authentication bugs and improved session handling.",
					commitCount: 3,
				},
				{
					user: "bob",
					narrative: "Added new dashboard widgets for analytics.",
					commitCount: 2,
				},
			];

			const report = formatDailyReport("2025-02-03", userSummaries);

			expect(report).toContain("# Daily Standup");
			expect(report).toContain("Monday, February 3, 2025");
			expect(report).toContain("**alice**");
			expect(report).toContain("**bob**");
			expect(report).toContain("authentication bugs");
			expect(report).toContain("dashboard widgets");
			expect(report).toContain("---"); // Separator between users
		});

		it("should handle empty summaries", () => {
			const report = formatDailyReport("2025-02-03", []);

			expect(report).toContain("# Daily Standup");
			expect(report).toContain("No activity to report");
		});

		it("should handle single user without separator", () => {
			const userSummaries: UserSummary[] = [
				{
					user: "solo",
					narrative: "Worked on various improvements.",
					commitCount: 1,
				},
			];

			const report = formatDailyReport("2025-02-03", userSummaries);

			expect(report).toContain("**solo**");
			expect(report).not.toContain("---"); // No separator for single user
		});
	});
});

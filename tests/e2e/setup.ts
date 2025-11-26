/**
 * E2E test setup utilities.
 * Provides test context, Redis isolation, and fixture loading.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { narrateDay, translateDiff } from "../../src/ai";
import { formatDailyReport, type UserSummary } from "../../src/core/formatting";
import type {
	DailyFixture,
	FixtureCommit,
	RepoMetadata,
} from "../fixtures/types";

// Test Redis connection - uses same URL as main app
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Test key prefix for isolation
const TEST_KEY_PREFIX = "elapse:test";

// TTL for test data (1 hour)
const TEST_TTL_SECONDS = 3600;

/**
 * Test context for E2E tests.
 */
export interface TestContext {
	testId: string;
	redis: Redis;
	keyPrefix: string;
}

/**
 * Create a unique test context for isolation.
 */
export function createTestContext(): TestContext {
	const testId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const redis = new Redis(REDIS_URL, {
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
	});

	return {
		testId,
		redis,
		keyPrefix: `${TEST_KEY_PREFIX}:${testId}`,
	};
}

/**
 * Clean up test context - remove all test keys and close connection.
 */
export async function cleanupTestContext(ctx: TestContext): Promise<void> {
	// Find and delete all keys with test prefix
	const pattern = `${ctx.keyPrefix}:*`;
	const keys = await ctx.redis.keys(pattern);

	if (keys.length > 0) {
		await ctx.redis.del(...keys);
	}

	await ctx.redis.quit();
}

/**
 * Generate test Redis key.
 * Format: elapse:test:{testId}:day:{date}:{user}
 */
export function testDayKey(
	ctx: TestContext,
	date: string,
	user: string,
): string {
	return `${ctx.keyPrefix}:day:${date}:${user}`;
}

/**
 * Store a translation in the test context.
 */
export async function storeTestTranslation(
	ctx: TestContext,
	date: string,
	user: string,
	translation: string,
): Promise<void> {
	if (translation === "SKIP") return;

	const key = testDayKey(ctx, date, user);
	await ctx.redis.rpush(key, translation);
	await ctx.redis.expire(key, TEST_TTL_SECONDS);
}

/**
 * Get all translations for a user on a given date.
 */
export async function getTestTranslations(
	ctx: TestContext,
	date: string,
	user: string,
): Promise<string[]> {
	return ctx.redis.lrange(testDayKey(ctx, date, user), 0, -1);
}

/**
 * Get all users who have translations for a given date.
 */
export async function getTestUsersForDate(
	ctx: TestContext,
	date: string,
): Promise<string[]> {
	const pattern = `${ctx.keyPrefix}:day:${date}:*`;
	const keys = await ctx.redis.keys(pattern);
	return keys.map((k) => k.split(":").at(-1) || "");
}

/**
 * Get all translations for all users on a given date.
 */
export async function getAllTestTranslationsForDate(
	ctx: TestContext,
	date: string,
): Promise<Map<string, string[]>> {
	const users = await getTestUsersForDate(ctx, date);
	const result = new Map<string, string[]>();

	for (const user of users) {
		result.set(user, await getTestTranslations(ctx, date, user));
	}

	return result;
}

// Fixture loading utilities

const FIXTURES_BASE = join(import.meta.dir, "../fixtures/e2e");

/**
 * List available fixture repositories.
 */
export function listFixtureRepos(): string[] {
	if (!existsSync(FIXTURES_BASE)) {
		return [];
	}

	return readdirSync(FIXTURES_BASE, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

/**
 * Load metadata for a fixture repository.
 */
export function loadRepoMetadata(repoName: string): RepoMetadata | null {
	const metadataPath = join(FIXTURES_BASE, repoName, "metadata.json");

	if (!existsSync(metadataPath)) {
		return null;
	}

	const content = readFileSync(metadataPath, "utf-8");
	return JSON.parse(content) as RepoMetadata;
}

/**
 * List available dates for a fixture repository.
 */
export function listFixtureDates(repoName: string): string[] {
	const repoDir = join(FIXTURES_BASE, repoName);

	if (!existsSync(repoDir)) {
		return [];
	}

	return readdirSync(repoDir)
		.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
		.map((f) => f.replace(".json", ""))
		.sort();
}

/**
 * Load a daily fixture for a repository.
 */
export function loadDailyFixture(
	repoName: string,
	date: string,
): DailyFixture | null {
	const fixturePath = join(FIXTURES_BASE, repoName, `${date}.json`);

	if (!existsSync(fixturePath)) {
		return null;
	}

	const content = readFileSync(fixturePath, "utf-8");
	return JSON.parse(content) as DailyFixture;
}

/**
 * Get all commits from a fixture that should be included (passed filtering).
 */
export function getIncludedCommits(fixture: DailyFixture): FixtureCommit[] {
	return fixture.commits.filter((c) => c.filterResult.included);
}

/**
 * Get all commits from a fixture that were excluded.
 */
export function getExcludedCommits(
	fixture: DailyFixture,
): Array<{ commit: FixtureCommit; reason: string }> {
	return fixture.commits
		.filter((c) => !c.filterResult.included)
		.map((c) => ({
			commit: c,
			reason: c.filterResult.excludeReason || "unknown",
		}));
}

/**
 * Group commits by user.
 */
export function groupCommitsByUser(
	commits: FixtureCommit[],
): Map<string, FixtureCommit[]> {
	const result = new Map<string, FixtureCommit[]>();

	for (const commit of commits) {
		const user = commit.user;
		if (!result.has(user)) {
			result.set(user, []);
		}
		result.get(user)?.push(commit);
	}

	return result;
}

/**
 * Assert that fixtures have been collected.
 * Throws if no fixtures are available.
 */
export function assertFixturesExist(repoName?: string): void {
	const repos = listFixtureRepos();

	if (repos.length === 0) {
		throw new Error(
			"No E2E fixtures found. Run 'bun run e2e:collect' first to fetch fixture data.",
		);
	}

	if (repoName && !repos.includes(repoName)) {
		throw new Error(
			`Fixture repository '${repoName}' not found. Available: ${repos.join(", ")}`,
		);
	}
}

// =============================================================================
// New Helper Types and Functions for Clean E2E Testing
// =============================================================================

/**
 * Entry for iterating over all fixtures.
 */
export interface FixtureEntry {
	repoName: string;
	date: string;
	fixture: DailyFixture;
	metadata: RepoMetadata;
}

/**
 * Result from finding a testable commit.
 */
export interface TestableCommitResult {
	commit: FixtureCommit;
	repoName: string;
	date: string;
}

/**
 * Configuration for running the full pipeline.
 */
export interface PipelineConfig {
	ctx: TestContext;
	repoName: string;
	maxCommits?: number;
	dateOverride?: string;
}

/**
 * Result from running the full pipeline.
 */
export interface PipelineResult {
	report: string;
	userSummaries: UserSummary[];
	translated: number;
	totalCommits: number;
	date: string;
}

/**
 * Iterate over all fixtures with a clean callback pattern.
 * Eliminates triple-nested loops in tests.
 */
export function forEachFixture(callback: (entry: FixtureEntry) => void): void {
	for (const repoName of listFixtureRepos()) {
		const metadata = loadRepoMetadata(repoName);
		if (!metadata) continue;

		for (const date of listFixtureDates(repoName)) {
			const fixture = loadDailyFixture(repoName, date);
			if (!fixture) continue;

			callback({ repoName, date, fixture, metadata });
		}
	}
}

/**
 * Find the first commit that matches a predicate.
 * Default predicate finds commits with valid diff sizes.
 */
export function findTestableCommit(
	predicate: (commit: FixtureCommit) => boolean = (c) =>
		c.diff.length > 0 && c.diff.length < 100000,
): TestableCommitResult | null {
	for (const repoName of listFixtureRepos()) {
		for (const date of listFixtureDates(repoName)) {
			const fixture = loadDailyFixture(repoName, date);
			if (!fixture) continue;

			const commit = getIncludedCommits(fixture).find(predicate);
			if (commit) return { commit, repoName, date };
		}
	}
	return null;
}

/**
 * Check if pipeline tests should be skipped.
 * Consolidated guard for API key, fixtures, and context.
 */
export function shouldSkipPipelineTest(ctx?: TestContext): boolean {
	const hasApiKey = Boolean(
		process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.LLM_MODEL_NAME,
	);
	const hasFixtures = listFixtureRepos().length > 0;
	const hasContext = ctx !== undefined;

	return !hasApiKey || !hasFixtures || !hasContext;
}

/**
 * Get all commits with a specific exclude reason across all fixtures.
 */
export function getCommitsByExcludeReason(
	reason: "bot" | "merge" | "lockfile-only",
): Array<{ commit: FixtureCommit; repoName: string; date: string }> {
	const results: Array<{
		commit: FixtureCommit;
		repoName: string;
		date: string;
	}> = [];

	forEachFixture(({ repoName, date, fixture }) => {
		for (const commit of fixture.commits) {
			if (commit.filterResult.excludeReason === reason) {
				results.push({ commit, repoName, date });
			}
		}
	});

	return results;
}

/**
 * Run the full pipeline for a repository.
 * Handles translate -> store -> narrate -> format.
 */
export async function runFullPipeline(
	config: PipelineConfig,
): Promise<PipelineResult | null> {
	const { ctx, repoName, maxCommits, dateOverride } = config;

	const metadata = loadRepoMetadata(repoName);
	if (!metadata) {
		console.warn(`${repoName} fixtures not found, skipping`);
		return null;
	}

	const dates = listFixtureDates(repoName);
	const date = dateOverride ?? dates[0];
	if (!date) return null;

	const fixture = loadDailyFixture(repoName, date);
	if (!fixture) return null;

	const included = getIncludedCommits(fixture);
	if (included.length === 0) {
		console.warn(`No included commits for ${repoName}, skipping`);
		return null;
	}

	const testCommits = maxCommits ? included.slice(0, maxCommits) : included;
	const testDateKey = `${date}-${repoName}-${ctx.testId}`;

	console.log(`\nProcessing ${testCommits.length} commits from ${repoName}...`);

	// Translate each commit
	let translated = 0;
	for (const commit of testCommits) {
		if (commit.diff.length === 0 || commit.diffTruncated) continue;

		console.log(`  Translating ${commit.sha.slice(0, 7)}...`);
		const translation = await translateDiff(commit.message, commit.diff);
		await storeTestTranslation(ctx, testDateKey, commit.user, translation);
		translated++;
	}

	// Generate narratives
	const userTranslations = await getAllTestTranslationsForDate(
		ctx,
		testDateKey,
	);
	const userSummaries: UserSummary[] = [];

	for (const [user, translations] of userTranslations) {
		console.log(`  Narrating for ${user} (${translations.length} commits)...`);
		const narrative = await narrateDay(translations, date);
		userSummaries.push({ user, narrative, commitCount: translations.length });
	}

	return {
		report: formatDailyReport(date, userSummaries),
		userSummaries,
		translated,
		totalCommits: included.length,
		date,
	};
}

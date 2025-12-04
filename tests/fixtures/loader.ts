/**
 * Fixture loader utilities for E2E tests.
 *
 * Loads daily fixtures from the e2e directory with real commit data
 * including diffs, PRs, and reviews.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CollectionConfig,
	DailyFixture,
	FixtureCommit,
	RepoMetadata,
} from "./types";

const FIXTURES_BASE = join(import.meta.dir, "e2e");

/**
 * Load the collection config.
 */
export function loadConfig(): CollectionConfig {
	const configPath = join(FIXTURES_BASE, "config.json");
	if (!existsSync(configPath)) {
		throw new Error(`Config not found at ${configPath}`);
	}
	const content = readFileSync(configPath, "utf-8");
	return JSON.parse(content) as CollectionConfig;
}

/**
 * Load a daily fixture for a repo and date.
 */
export function loadDailyFixture(repo: string, date: string): DailyFixture {
	const filepath = join(FIXTURES_BASE, repo, `${date}.json`);
	if (!existsSync(filepath)) {
		throw new Error(`Fixture not found: ${filepath}`);
	}
	const content = readFileSync(filepath, "utf-8");
	return JSON.parse(content) as DailyFixture;
}

/**
 * Load metadata for a repo.
 */
export function loadRepoMetadata(repo: string): RepoMetadata {
	const filepath = join(FIXTURES_BASE, repo, "metadata.json");
	if (!existsSync(filepath)) {
		throw new Error(`Metadata not found: ${filepath}`);
	}
	const content = readFileSync(filepath, "utf-8");
	return JSON.parse(content) as RepoMetadata;
}

/**
 * List all available dates for a repo.
 */
export function listAvailableDates(repo: string): string[] {
	const repoDir = join(FIXTURES_BASE, repo);
	if (!existsSync(repoDir)) {
		return [];
	}

	const files = readdirSync(repoDir);
	return files
		.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
		.map((f) => f.replace(".json", ""))
		.sort();
}

/**
 * List all available repos.
 */
export function listAvailableRepos(): string[] {
	if (!existsSync(FIXTURES_BASE)) {
		return [];
	}

	const entries = readdirSync(FIXTURES_BASE, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * Get all included commits from a fixture (filtered by filterResult.included).
 */
export function getIncludedCommits(fixture: DailyFixture): FixtureCommit[] {
	return fixture.commits.filter((c) => c.filterResult.included);
}

/**
 * Get unique PRs from a fixture.
 */
export function getUniquePRs(
	fixture: DailyFixture,
): Map<number, FixtureCommit["associatedPR"]> {
	const prs = new Map<number, FixtureCommit["associatedPR"]>();
	for (const commit of fixture.commits) {
		if (commit.associatedPR) {
			prs.set(commit.associatedPR.number, commit.associatedPR);
		}
	}
	return prs;
}

/**
 * Check if e2e fixtures are available.
 */
export function hasE2EFixtures(): boolean {
	const repos = listAvailableRepos();
	return repos.length > 0;
}

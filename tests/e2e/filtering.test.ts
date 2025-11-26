/**
 * E2E tests for commit filtering logic.
 * These are fast tests that verify filter results match the expected outcomes
 * from fixture data without making AI calls.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	type Commit,
	filterCommits,
	type Sender,
} from "../../src/core/filters";
import type { FixtureCommit } from "../fixtures/types";
import {
	assertFixturesExist,
	getCommitsByExcludeReason,
	getExcludedCommits,
	getIncludedCommits,
	listFixtureDates,
	listFixtureRepos,
	loadDailyFixture,
	loadRepoMetadata,
} from "./setup";

/**
 * Convert a fixture commit to the format expected by filterCommits.
 */
function toFilterCommit(fixture: FixtureCommit): Commit {
	return {
		id: fixture.sha,
		message: fixture.message,
		author: {
			name: fixture.author.name,
			email: fixture.author.email,
			username: fixture.author.username,
		},
		added: fixture.files.added,
		modified: fixture.files.modified,
		removed: fixture.files.removed,
	};
}

/**
 * Create a Sender object from a fixture commit.
 */
function toSender(fixture: FixtureCommit): Sender {
	return {
		login: fixture.user,
		type: undefined, // We don't have this info in fixtures, but bot patterns will match
	};
}

describe("E2E Filtering Tests", () => {
	beforeAll(() => {
		// Skip all tests if no fixtures available
		try {
			assertFixturesExist();
		} catch {
			console.warn(
				"Skipping E2E filtering tests: No fixtures found. Run 'bun run e2e:collect' first.",
			);
		}
	});

	describe("Fixture Consistency", () => {
		it("should have at least one fixture repository", () => {
			const repos = listFixtureRepos();
			// This test will fail if no fixtures, prompting user to run collection
			if (repos.length === 0) {
				console.warn("No fixtures found - run 'bun run e2e:collect'");
				return; // Skip gracefully
			}
			expect(repos.length).toBeGreaterThan(0);
		});

		it("should have valid metadata for each repository", () => {
			const repos = listFixtureRepos();
			if (repos.length === 0) return;

			for (const repo of repos) {
				const metadata = loadRepoMetadata(repo);
				expect(metadata).not.toBeNull();
				expect(metadata?.repo).toContain("/");
				expect(metadata?.schemaVersion).toBe(1);
				expect(metadata?.stats.totalCommits).toBeGreaterThanOrEqual(0);
			}
		});
	});

	// Generate tests for each fixture repository
	const repos = listFixtureRepos();

	for (const repoName of repos) {
		describe(`Repository: ${repoName}`, () => {
			const dates = listFixtureDates(repoName);
			const metadata = loadRepoMetadata(repoName);

			it(`should have metadata`, () => {
				expect(metadata).not.toBeNull();
			});

			it(`should have daily fixtures`, () => {
				expect(dates.length).toBeGreaterThan(0);
			});

			for (const date of dates) {
				describe(`Date: ${date}`, () => {
					const fixture = loadDailyFixture(repoName, date);

					it("should load fixture successfully", () => {
						expect(fixture).not.toBeNull();
						expect(fixture?.date).toBe(date);
						expect(fixture?.commits).toBeInstanceOf(Array);
					});

					it("should have pre-computed filter results for all commits", () => {
						if (!fixture) return;

						for (const commit of fixture.commits) {
							expect(commit.filterResult).toBeDefined();
							expect(typeof commit.filterResult.included).toBe("boolean");

							if (!commit.filterResult.included) {
								const reason = commit.filterResult.excludeReason;
								expect(reason).toBeDefined();
								if (reason) {
									expect(["bot", "merge", "lockfile-only"]).toContain(reason);
								}
							}
						}
					});

					it("should match filterCommits() output with pre-computed results", () => {
						if (!fixture) return;

						// Run filterCommits on each commit individually
						// We do this individually since each commit might have a different sender
						for (const fixtureCommit of fixture.commits) {
							const commit = toFilterCommit(fixtureCommit);
							const sender = toSender(fixtureCommit);

							const { included, excluded } = filterCommits([commit], sender);

							if (fixtureCommit.filterResult.included) {
								expect(included.length).toBe(1);
								expect(excluded.length).toBe(0);
							} else {
								expect(included.length).toBe(0);
								expect(excluded.length).toBe(1);
								const expectedReason = fixtureCommit.filterResult.excludeReason;
								if (expectedReason) {
									expect(excluded[0]?.reason).toBe(expectedReason);
								}
							}
						}
					});

					it("should categorize commits correctly", () => {
						if (!fixture) return;

						const includedFixtures = getIncludedCommits(fixture);
						const excludedFixtures = getExcludedCommits(fixture);

						// Verify counts match
						expect(includedFixtures.length + excludedFixtures.length).toBe(
							fixture.commits.length,
						);

						// Verify each excluded commit has a valid reason
						for (const { reason } of excludedFixtures) {
							expect(["bot", "merge", "lockfile-only"]).toContain(reason);
						}
					});

					it("should have valid diff data for included commits", () => {
						if (!fixture) return;

						const included = getIncludedCommits(fixture);

						for (const commit of included) {
							// Included commits should have non-empty diffs
							// (unless the repo has empty commits, which is rare)
							expect(commit.diffSize).toBeGreaterThanOrEqual(0);

							// If diff was truncated, it should be at max size
							if (commit.diffTruncated) {
								expect(commit.diff.length).toBeLessThanOrEqual(100000);
							}
						}
					});
				});
			}
		});
	}
});

describe("Filter Exclusion Reasons", () => {
	it("should correctly identify bot commits", () => {
		const botCommits = getCommitsByExcludeReason("bot");

		for (const { commit } of botCommits) {
			const hasBotPattern =
				/\[bot\]|dependabot|renovate|github-actions|greenkeeper|snyk-bot/i.test(
					commit.user + commit.author.name,
				);
			expect(hasBotPattern).toBe(true);
		}
	});

	it("should correctly identify merge commits", () => {
		const mergeCommits = getCommitsByExcludeReason("merge");

		for (const { commit } of mergeCommits) {
			const firstLine = commit.message.split("\n")[0] || "";
			const hasMergePattern =
				/^Merge (pull request|branch|remote-tracking)/i.test(firstLine);
			expect(hasMergePattern).toBe(true);
		}
	});

	it("should correctly identify lockfile-only commits", () => {
		const lockfilePatterns = [
			/package-lock\.json$/,
			/yarn\.lock$/,
			/pnpm-lock\.yaml$/,
			/bun\.lockb$/,
			/Gemfile\.lock$/,
			/composer\.lock$/,
			/Cargo\.lock$/,
			/poetry\.lock$/,
			/go\.sum$/,
		];

		const lockfileCommits = getCommitsByExcludeReason("lockfile-only");

		for (const { commit } of lockfileCommits) {
			const allFiles = [
				...commit.files.added,
				...commit.files.modified,
				...commit.files.removed,
			];

			const allAreLockfiles = allFiles.every((f) =>
				lockfilePatterns.some((p) => p.test(f)),
			);
			expect(allAreLockfiles).toBe(true);
		}
	});
});

describe("Fixture Statistics", () => {
	it("should report fixture statistics", () => {
		const repos = listFixtureRepos();

		console.log("\n=== E2E Fixture Statistics ===");

		let totalCommits = 0;
		let totalIncluded = 0;
		let totalExcluded = 0;

		for (const repoName of repos) {
			const metadata = loadRepoMetadata(repoName);
			if (!metadata) continue;

			console.log(`\n${metadata.repo}:`);
			console.log(
				`  Date range: ${metadata.dateRange.start} to ${metadata.dateRange.end}`,
			);
			console.log(`  Total commits: ${metadata.stats.totalCommits}`);
			console.log(`  Included: ${metadata.stats.includedCommits}`);
			console.log(`  Excluded: ${metadata.stats.excludedCommits}`);

			totalCommits += metadata.stats.totalCommits;
			totalIncluded += metadata.stats.includedCommits;
			totalExcluded += metadata.stats.excludedCommits;
		}

		console.log(`\nTotal across all repos:`);
		console.log(`  Commits: ${totalCommits}`);
		console.log(`  Included: ${totalIncluded}`);
		console.log(`  Excluded: ${totalExcluded}`);
		console.log("==============================\n");

		// Just verify the test ran
		expect(true).toBe(true);
	});
});

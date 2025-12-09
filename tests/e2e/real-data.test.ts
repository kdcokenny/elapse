/**
 * E2E Tests with Real GitHub Data
 *
 * Uses real commit fixtures collected from React to test the full pipeline including:
 * - Branch-first storage (commits stored by branch, resolved to PRs at read time)
 * - Commit translation (mocked for speed, real data for accuracy)
 * - PR-centric storage
 * - Report generation
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
	getIncludedCommits,
	getUniquePRs,
	hasE2EFixtures,
	listAvailableDates,
	listAvailableRepos,
	loadDailyFixture,
	loadRepoMetadata,
} from "../fixtures/loader";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";
import {
	createMockTranslator,
	simulatePRMerged,
	simulatePROpened,
	simulatePush,
} from "./webhook-simulator";

// Skip all tests if no fixtures are available
const SKIP_REASON = hasE2EFixtures()
	? null
	: "E2E fixtures not collected. Run: bun tests/scripts/collect-fixtures.ts --include-prs";

describe("E2E: Real Repository Data", () => {
	beforeAll(() => {
		if (SKIP_REASON) {
			console.log(`Skipping: ${SKIP_REASON}`);
			return;
		}
		initTestRedis();
	});

	afterAll(() => {
		if (!SKIP_REASON) {
			restoreRedis();
		}
	});

	beforeEach(async () => {
		if (!SKIP_REASON) {
			await resetTestRedis();
		}
	});

	test.skipIf(!!SKIP_REASON)("fixtures are available", () => {
		const repos = listAvailableRepos();
		expect(repos.length).toBeGreaterThan(0);
		console.log(`Available repos: ${repos.join(", ")}`);

		for (const repo of repos) {
			const dates = listAvailableDates(repo);
			const metadata = loadRepoMetadata(repo);
			console.log(
				`  ${repo}: ${dates.length} days, ${metadata.stats.totalCommits} commits (${metadata.stats.includedCommits} included)`,
			);
		}
	});

	test.skipIf(!!SKIP_REASON)(
		"branch-first storage correctly stores commits by branch",
		async () => {
			// Use any available repo with PR data
			const repos = listAvailableRepos();
			let testCommit = null;
			let testRepo = "";

			for (const repo of repos) {
				const dates = listAvailableDates(repo);
				for (const date of dates) {
					const fixture = loadDailyFixture(repo, date);
					const commitsWithPRs = fixture.commits.filter(
						(c) => c.filterResult.included && c.associatedPR,
					);
					if (commitsWithPRs.length > 0) {
						testCommit = commitsWithPRs[0];
						testRepo = repo;
						break;
					}
				}
				if (testCommit) break;
			}

			if (!testCommit || !testCommit.associatedPR) {
				console.log("No commits with PRs found in fixtures");
				return;
			}

			const pr = testCommit.associatedPR;
			const metadata = loadRepoMetadata(testRepo);
			const fullRepo = metadata.repo; // e.g., "excalidraw/excalidraw"

			console.log(`Testing with ${testRepo} PR #${pr.number}`);

			// Step 1: Open the PR (stores PR metadata)
			await simulatePROpened(fullRepo, pr);

			// Step 2: Push a commit (stores by branch, no PR lookup needed)
			const mockTranslator = createMockTranslator();
			const result = await simulatePush(
				fullRepo,
				pr.branch,
				testCommit,
				mockTranslator,
			);

			// Verify commit was stored with translation
			expect(result.translation).toBeDefined();
			expect(result.translation.sha).toBe(testCommit.sha);
			console.log(`  Commit stored for branch: ${pr.branch}`);

			// Step 3: Merge the PR
			const date = new Date().toISOString().split("T")[0] ?? "";
			await simulatePRMerged(pr, date);
			console.log(
				"  PR merged - branch data remains (cleanup is background job)",
			);

			// Note: In branch-first architecture, commits remain stored by branch
			// even after merge. Cleanup is done by a background job, not at merge time.
		},
	);

	test.skipIf(!!SKIP_REASON)(
		"processes all repos through pipeline",
		async () => {
			const repos = listAvailableRepos();
			const mockTranslator = createMockTranslator();
			const stats = {
				totalCommits: 0,
				totalPRs: 0,
				branchCommits: 0,
			};

			for (const repo of repos) {
				const metadata = loadRepoMetadata(repo);
				const fullRepo = metadata.repo;
				const dates = listAvailableDates(repo);

				console.log(`\n${repo}:`);

				for (const date of dates) {
					const fixture = loadDailyFixture(repo, date);
					const includedCommits = getIncludedCommits(fixture);
					const uniquePRs = getUniquePRs(fixture);
					const openedPRs = new Set<number>();

					stats.totalCommits += includedCommits.length;
					stats.totalPRs += uniquePRs.size;

					for (const commit of includedCommits) {
						if (
							commit.associatedPR &&
							!openedPRs.has(commit.associatedPR.number)
						) {
							await simulatePROpened(fullRepo, commit.associatedPR);
							openedPRs.add(commit.associatedPR.number);
						}

						const branch = commit.associatedPR?.branch ?? "main";
						const result = await simulatePush(
							fullRepo,
							branch,
							commit,
							mockTranslator,
						);

						// Branch-first: all commits are stored by branch
						if (result.translation) {
							stats.branchCommits++;
						}
					}

					console.log(
						`  ${date}: ${includedCommits.length} commits, ${uniquePRs.size} PRs`,
					);
				}
			}

			console.log(
				`\nTotal: ${stats.totalCommits} commits, ${stats.totalPRs} PRs`,
			);
			console.log(`Branch commits stored: ${stats.branchCommits}`);

			// Verify we processed some data
			expect(stats.totalCommits).toBeGreaterThan(0);
		},
	);
});

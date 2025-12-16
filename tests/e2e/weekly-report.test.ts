/**
 * E2E Test for Weekly Report Generation (Manual Verification)
 *
 * PURPOSE: Generate real weekly reports for MANUAL INSPECTION.
 * This is NOT an automated pass/fail test - it logs output for human review.
 *
 * Uses REAL GitHub data from facebook/react and REAL AI calls.
 * NO MOCKING - tests the full pipeline end-to-end.
 *
 * Run with: bun test tests/e2e/weekly-report.test.ts
 * Expected duration: 2-5 minutes (real AI calls on ~36 commits)
 *
 * =============================================================================
 * EXPECTED DATA (facebook/react, Oct 14-20, 2024)
 * =============================================================================
 *
 * RAW FIXTURE SUMMARY:
 * - 36 commits total (29 weekday + 7 Sunday)
 * - 36 unique PRs (all merged)
 * - Multiple contributors
 * - 1 BLOCKER: PR #31273 (open with CHANGES_REQUESTED + pending review)
 *
 * DAILY BREAKDOWN:
 *
 * Monday (Oct 14) - 5 commits:
 *   - #31238: [Re-land] Make prerendering always non-blocking (jackpope)
 *   - #31240: [ci] Specify limited concurrency for PR jobs (poteto)
 *   - #31239: [ci] Consistent cache names (poteto)
 *   - #31177: [compiler] Use consistent version hash for npm (poteto)
 *   - #31175: [string-refs] make disableStringRefs a dynamic www flag (kassens)
 *
 * Tuesday (Oct 15) - 5 commits:
 *   - #31268: [Re-land] Make prerendering always non-blocking (jackpope)
 *   - #31208: [ESLint] Add test for rejected useId in async Components (eps1lon)
 *   - #31263: React DevTools 6.0.0 -> 6.0.1 (hoxyq)
 *   - #31196: [DevTools] Fix React Compiler badging (poteto)
 *   - #31261: fix[react-devtools]: fixed timeline profiler tests (hoxyq)
 *
 * Wednesday (Oct 16) - 4 commits:
 *   - #31277: [ez] Update references to 'forget' in react-compiler-runtime (poteto)
 *   - #31276: Delete __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED (yungsters)
 *   - #31274: Add Bridge types for Fusebox (EdmondChuiHW)
 *   - #31270: [Flight] Enable sync stack traces for errors and console replay (sebmarkbage)
 *
 * Thursday (Oct 17) - 4 commits:
 *   - #31283: [ci] Allow passing various params to compiler publish script (poteto)
 *   - #31278: [compiler] Clean up publish script (poteto)
 *   - #30956: JSX Outlining (gsathya)
 *   - #31241: tests[react-devtools]: added tests for Compiler integration (hoxyq)
 *
 * Friday (Oct 18) - 11 commits:
 *   - #31297: [ez] Update compiler issue template (poteto)
 *   - #31296: [ci] Don't use branch name for concurrency (poteto)
 *   - #31294: [ci] Publish compiler weekly prereleases (poteto)
 *   - #31282: [compiler] InlineJSXTransform transforms jsx inside function expressions (josephsavona)
 *   - #31293: [playground] Upgrade various packages (poteto)
 *   - #31292: [playground] Remove unnecessary fs package (poteto)
 *   - #31291: [playground] Upgrade to Next 15 (poteto)
 *   - #31289: [fixture] Update compiler to use latest package (poteto)
 *   - #31288: [ci:compiler] Only add latest tag to non-experimental (poteto)
 *   - #31286: Audit try/finally around console patching (sebmarkbage)
 *   - #31284: [ci] Don't auto push to latest tag (poteto)
 *
 * Sunday (Oct 20) - 7 commits (WEEKEND - rolls into Week 2):
 *   - #31304: Fix timing issue with fake promise resolving sync (sebmarkbage)
 *   - #31303: Fix types (sebmarkbage)
 *   - #31302: [Flight] Handle bound arguments for loaded server references (sebmarkbage)
 *   - #31301: [Flight] Align turbopack option name with webpack name (sebmarkbage)
 *   - #31298: Expose prerender() for SSG in stable (sebmarkbage)
 *   - #31300: [Flight] Add serverModuleMap option for mapping ServerReferences (sebmarkbage)
 *   - #31299: Rename SSRManifest to ServerConsumerManifest (sebmarkbage)
 *
 * BLOCKER DATA (PR #31273 - not in fixtures, added manually):
 *   - Title: "Fix propagation of legacy context when used with memo"
 *   - Author: sophiebits
 *   - Created: Oct 16, 2024
 *   - State: OPEN (still open today!)
 *   - CHANGES_REQUESTED from sebmarkbage on Oct 16
 *   - Pending review from acdlite (requested, never responded)
 *   - Author says "I don't expect we'll land this" in description
 *
 * =============================================================================
 * EXPECTED WEEKLY REPORT OUTPUT
 * =============================================================================
 *
 * EXPECTED VALUES (Week 1, Oct 14-18):
 *   - RAG Status: 🟡 Yellow / "At Risk" (PR #31273 has active blocker)
 *   - PRs Merged: ~29 (weekday only, not including Sunday)
 *   - Active Blockers: 1 (PR #31273)
 *
 * EXPECTED THEMATIC GROUPS (AI should identify these themes):
 *   1. Compiler Infrastructure - poteto, josephsavona, gsathya
 *   2. CI/Build Pipeline - poteto
 *   3. DevTools - hoxyq, poteto
 *   4. Flight/RSC - sebmarkbage
 *   5. React Native/Core - yungsters, kassens, jackpope
 *
 * EXPECTED BLOCKERS SECTION:
 *   - Should mention PR #31273 or "legacy context" blocker
 *   - Should mention it has changes requested
 *
 * =============================================================================
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { translateDiff } from "../../src/ai";
import { formatWeeklyThreadContent } from "../../src/core/formatting";
import {
	addBranchCommit,
	createOrUpdatePR,
	recordPRMerged,
	setPRBlocker,
	setPRStatus,
} from "../../src/redis";
import { generateWeeklyReport } from "../../src/weekly-reporter";
import {
	getIncludedCommits,
	hasE2EFixtures,
	listAvailableDates,
	listAvailableRepos,
	loadDailyFixture,
	loadRepoMetadata,
} from "../fixtures/loader";
import type { FixtureCommit } from "../fixtures/types";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";
import { extractWeeklyStats, validateWeeklyFormat } from "./weekly-setup";

// Skip all tests if no fixtures are available
const SKIP_REASON = hasE2EFixtures()
	? null
	: "E2E fixtures not collected. Run: GITHUB_TOKEN=$(gh auth token) bun tests/scripts/collect-fixtures.ts --include-prs";

// Store original Date.now for restoration
const originalDateNow = Date.now;

describe("E2E: Weekly Report with Real AI", () => {
	beforeAll(() => {
		if (SKIP_REASON) {
			console.log(`Skipping: ${SKIP_REASON}`);
			return;
		}
		initTestRedis();
	});

	afterAll(() => {
		Date.now = originalDateNow;
		if (!SKIP_REASON) {
			restoreRedis();
		}
	});

	beforeEach(async () => {
		if (!SKIP_REASON) {
			await resetTestRedis();
		}
	});

	test.skipIf(!!SKIP_REASON)(
		"generates weekly report from React repo data with real AI and blocker",
		async () => {
			const repos = listAvailableRepos();
			expect(repos.length).toBeGreaterThan(0);

			// Use the React repo
			const repoName = repos.find((r) => r.includes("react"));
			if (!repoName) {
				console.log("React repo not found in fixtures, skipping");
				return;
			}

			const metadata = loadRepoMetadata(repoName);
			const fullRepo = metadata.repo; // "facebook/react"
			const dates = listAvailableDates(repoName);

			console.log(`\n${"=".repeat(60)}`);
			console.log(`WEEKLY REPORT E2E TEST - MANUAL VERIFICATION`);
			console.log(`${"=".repeat(60)}`);
			console.log(`Repository: ${fullRepo}`);
			console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
			console.log(`Total commits: ${metadata.stats.includedCommits}`);
			console.log(`\nUsing REAL AI - expect 2-5 minutes runtime\n`);

			// =================================================================
			// STEP 1: Add the blocker PR #31273 (not in fixtures)
			// =================================================================
			console.log(`--- Adding blocker PR #31273 ---`);
			await createOrUpdatePR(31273, {
				repo: fullRepo,
				branch: "legacy-context-fix",
				title: "Fix propagation of legacy context when used with memo",
				authors: ["sophiebits"],
				status: "open",
				openedAt: "2024-10-16T08:41:55Z",
			});

			// Add CHANGES_REQUESTED blocker from sebmarkbage
			await setPRBlocker(31273, "review:sebmarkbage", {
				type: "changes_requested",
				description:
					"Changes requested by sebmarkbage: Legacy context should be deleted",
				detectedAt: "2024-10-16T14:32:04Z",
				mentionedUsers: ["sebmarkbage"],
			});

			// Add pending review blocker from acdlite
			await setPRBlocker(31273, "pending:acdlite", {
				type: "stale_review",
				description: "Pending review from acdlite (no response since Oct 16)",
				detectedAt: "2024-10-16T08:41:55Z",
				mentionedUsers: ["acdlite"],
			});

			console.log(`  PR #31273 added with 2 blockers`);

			// =================================================================
			// STEP 2: Process weekday commits only (Mon-Fri, not Sunday)
			// =================================================================
			const weekdayDates = dates.filter((d) => d !== "2024-10-20");
			console.log(
				`\n--- Processing weekday commits (${weekdayDates.join(", ")}) ---`,
			);

			// Track stats
			let processedCommits = 0;
			const processedPRs = new Set<number>();
			const mergedPRs = new Set<number>();

			// Process each weekday
			for (const date of weekdayDates) {
				const fixture = loadDailyFixture(repoName, date);
				const commits = getIncludedCommits(fixture);

				console.log(`\n--- ${date}: ${commits.length} commits ---`);

				for (const commit of commits) {
					// 1. Ensure PR exists
					if (commit.associatedPR) {
						const pr = commit.associatedPR;
						if (!processedPRs.has(pr.number)) {
							await createOrUpdatePR(pr.number, {
								repo: fullRepo,
								branch: pr.branch,
								title: pr.title,
								authors: [pr.author],
								status: "open",
								openedAt: commit.timestamp,
							});
							processedPRs.add(pr.number);
						}
					}

					// 2. Translate with REAL AI
					console.log(`  Translating ${commit.sha.slice(0, 7)}...`);
					const translation = await translateWithRetry(commit);

					if (translation.action === "skip" || !translation.summary) {
						console.log(`    -> Skipped`);
						continue;
					}

					console.log(`    -> ${translation.summary.slice(0, 60)}...`);

					// 3. Store translation
					const branch = commit.associatedPR?.branch || "main";
					await addBranchCommit(fullRepo, branch, {
						sha: commit.sha,
						summary: translation.summary,
						category: translation.category,
						significance: translation.significance,
						author: commit.user,
						timestamp: commit.timestamp,
					});

					processedCommits++;

					// 4. Record PR merge
					if (
						commit.associatedPR?.merged &&
						!mergedPRs.has(commit.associatedPR.number)
					) {
						const pr = commit.associatedPR;
						await setPRStatus(pr.number, "merged", date);
						await recordPRMerged(pr.number, date);
						mergedPRs.add(pr.number);
						console.log(`    -> PR #${pr.number} merged`);
					}
				}
			}

			// =================================================================
			// STEP 3: Generate weekly report for Friday Oct 18
			// =================================================================
			const reportDate = new Date("2024-10-18T16:00:00Z");
			Date.now = () => reportDate.getTime();

			console.log(`\n${"=".repeat(60)}`);
			console.log(`GENERATING WEEKLY REPORT`);
			console.log(`${"=".repeat(60)}`);
			console.log(`Commits processed: ${processedCommits}`);
			console.log(`PRs processed: ${processedPRs.size}`);
			console.log(`PRs merged: ${mergedPRs.size}`);
			console.log(`Blocker PR #31273: OPEN with 2 blockers`);

			const { data, watermark } = await generateWeeklyReport(reportDate);
			const report = data ? formatWeeklyThreadContent(data) : null;

			console.log(`\n${"=".repeat(60)}`);
			console.log(`WEEKLY REPORT OUTPUT (for manual verification)`);
			console.log(`${"=".repeat(60)}\n`);
			console.log(report ?? "(no report generated)");
			console.log(`\n${"=".repeat(60)}`);
			console.log(`Watermark: ${watermark}`);
			console.log(`${"=".repeat(60)}\n`);

			// =================================================================
			// STEP 4: Validate report format
			// =================================================================
			expect(report).toBeTruthy();
			if (!report) throw new Error("report is null");

			const validation = validateWeeklyFormat(report);
			console.log(`\nFormat validation:`);
			console.log(`  Valid: ${validation.valid}`);
			if (validation.errors.length > 0) {
				console.log(`  Errors: ${validation.errors.join(", ")}`);
			}
			if (validation.warnings.length > 0) {
				console.log(`  Warnings: ${validation.warnings.join(", ")}`);
			}

			expect(validation.errors).toEqual([]);

			// =================================================================
			// STEP 5: Validate stats
			// =================================================================
			const stats = extractWeeklyStats(report);
			console.log(`\nExtracted stats:`);
			console.log(`  PRs merged: ${stats.prsMerged}`);
			console.log(`  Blockers resolved: ${stats.blockersResolved}`);
			console.log(`  Active blockers: ${stats.activeBlockers}`);
			console.log(`  In progress: ${stats.inProgress}`);

			// Should have merged PRs
			expect(stats.prsMerged).toBeGreaterThan(0);

			// =================================================================
			// STEP 6: Check for blocker mention
			// =================================================================
			console.log(`\n--- Blocker Detection Check ---`);
			const reportLower = report.toLowerCase();
			const mentionsBlocker =
				reportLower.includes("blocker") ||
				reportLower.includes("changes requested") ||
				reportLower.includes("legacy context") ||
				reportLower.includes("at risk") ||
				reportLower.includes("blocked");

			console.log(
				`  Report mentions blocker-related content: ${mentionsBlocker}`,
			);

			// The RAG status should be yellow or red due to the blocker
			const hasYellowOrRed =
				report.includes("🟡 At Risk") || report.includes("🔴 Blocked");
			console.log(`  RAG status is yellow or red: ${hasYellowOrRed}`);

			// Note: We don't strictly assert on blocker detection since the
			// blocker PR #31273 is not in the merged data, only in open PRs.
			// The test is for manual verification of blocker handling.
		},
		300000, // 5 minute timeout
	);
});

/**
 * Translate with retry logic for transient AI failures.
 */
async function translateWithRetry(commit: FixtureCommit, maxRetries = 3) {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await translateDiff(commit.message, commit.diff);
		} catch (error) {
			console.log(
				`    Attempt ${attempt}/${maxRetries} failed: ${(error as Error).message}`,
			);
			if (attempt < maxRetries) {
				await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
			}
		}
	}

	console.log(`    All retries failed, skipping`);
	return {
		action: "skip" as const,
		summary: null,
		category: null,
		significance: null,
	};
}

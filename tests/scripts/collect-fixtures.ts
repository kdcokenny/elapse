#!/usr/bin/env bun
/**
 * CLI script to collect E2E test fixtures from GitHub.
 * Fetches commits and diffs, applies filtering, saves to JSON files.
 *
 * Usage:
 *   bun run e2e:collect
 *   bun run e2e:collect --repo excalidraw/excalidraw --from 2025-02-01 --to 2025-02-03
 *
 * Requires: GITHUB_TOKEN environment variable
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import {
	isBotCommit,
	isLockfileOnlyCommit,
	isMergeCommit,
} from "../../src/core/filters";
import type {
	CollectionConfig,
	CommitAuthor,
	CommitFiles,
	DailyFixture,
	FilterResult,
	FixtureCommit,
	RepoMetadata,
} from "../fixtures/types";

// Load config
const CONFIG_PATH = join(import.meta.dir, "../fixtures/e2e/config.json");
const FIXTURES_BASE = join(import.meta.dir, "../fixtures/e2e");

function loadConfig(): CollectionConfig {
	const content = readFileSync(CONFIG_PATH, "utf-8");
	return JSON.parse(content) as CollectionConfig;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedArgs {
	repo?: string;
	from?: string;
	to?: string;
	help?: boolean;
}

function parseCliArgs(): ParsedArgs {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			repo: { type: "string", short: "r" },
			from: { type: "string", short: "f" },
			to: { type: "string", short: "t" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});
	return values as ParsedArgs;
}

function printHelp(): void {
	console.log(`
E2E Fixture Collection Script

Usage:
  bun tests/scripts/collect-fixtures.ts [options]

Options:
  -r, --repo <owner/repo>   Collect for specific repo only
  -f, --from <YYYY-MM-DD>   Start date (overrides config)
  -t, --to <YYYY-MM-DD>     End date (overrides config)
  -h, --help                Show this help message

Environment:
  GITHUB_TOKEN              Required for GitHub API access

Examples:
  bun tests/scripts/collect-fixtures.ts
  bun tests/scripts/collect-fixtures.ts --repo excalidraw/excalidraw
  bun tests/scripts/collect-fixtures.ts --from 2025-02-01 --to 2025-02-07
`);
}

/**
 * Determine the filter result for a commit.
 */
function getFilterResult(
	commit: { message: string; author: CommitAuthor; files: CommitFiles },
	senderLogin: string,
): FilterResult {
	const filterCommit = {
		id: "",
		message: commit.message,
		author: {
			name: commit.author.name,
			email: commit.author.email,
			username: commit.author.username,
		},
		added: commit.files.added,
		modified: commit.files.modified,
		removed: commit.files.removed,
	};

	const sender = { login: senderLogin, type: undefined };

	if (isBotCommit(filterCommit, sender)) {
		return { included: false, excludeReason: "bot" };
	}
	if (isMergeCommit(filterCommit)) {
		return { included: false, excludeReason: "merge" };
	}
	if (isLockfileOnlyCommit(filterCommit)) {
		return { included: false, excludeReason: "lockfile-only" };
	}

	return { included: true };
}

/**
 * Collect fixtures for a single repository.
 */
async function collectRepoFixtures(
	octokit: Octokit,
	owner: string,
	repo: string,
	dateRange: { start: string; end: string },
	config: CollectionConfig,
): Promise<void> {
	const repoFullName = `${owner}/${repo}`;
	const repoDir = join(FIXTURES_BASE, repo);

	console.log(`\nCollecting fixtures for ${repoFullName}...`);
	console.log(`  Date range: ${dateRange.start} to ${dateRange.end}`);

	// Ensure repo directory exists
	if (!existsSync(repoDir)) {
		mkdirSync(repoDir, { recursive: true });
	}

	// Fetch commits in date range
	const commits = await octokit.repos.listCommits({
		owner,
		repo,
		since: `${dateRange.start}T00:00:00Z`,
		until: `${dateRange.end}T23:59:59Z`,
		per_page: config.maxCommitsPerRepo,
	});

	console.log(`  Found ${commits.data.length} commits`);

	// Group commits by date
	const commitsByDate = new Map<string, FixtureCommit[]>();
	let includedCount = 0;
	let excludedCount = 0;

	for (const commit of commits.data) {
		console.log(`  Processing ${commit.sha.slice(0, 7)}...`);

		// Rate limiting
		await sleep(config.rateLimitDelayMs);

		// Fetch commit details with diff
		const commitDetails = await octokit.repos.getCommit({
			owner,
			repo,
			ref: commit.sha,
		});

		// Fetch diff separately
		const diffResponse = await octokit.repos.getCommit({
			owner,
			repo,
			ref: commit.sha,
			mediaType: { format: "diff" },
		});
		const diff = diffResponse.data as unknown as string;

		// Extract author info
		const author: CommitAuthor = {
			name: commit.commit.author?.name || "Unknown",
			email: commit.commit.author?.email || "",
			username: commit.author?.login || null,
		};

		// Extract files
		const files: CommitFiles = {
			added:
				commitDetails.data.files
					?.filter((f) => f.status === "added")
					.map((f) => f.filename) || [],
			modified:
				commitDetails.data.files
					?.filter((f) => f.status === "modified")
					.map((f) => f.filename) || [],
			removed:
				commitDetails.data.files
					?.filter((f) => f.status === "removed")
					.map((f) => f.filename) || [],
		};

		// Get user login (sender equivalent)
		const userLogin = commit.author?.login || author.name;

		// Determine filter result
		const filterResult = getFilterResult(
			{ message: commit.commit.message, author, files },
			userLogin,
		);

		if (filterResult.included) {
			includedCount++;
		} else {
			excludedCount++;
			console.log(`    Excluded: ${filterResult.excludeReason}`);
		}

		// Truncate large diffs
		let diffContent = diff;
		let diffTruncated = false;
		if (diff.length > config.maxDiffSize) {
			diffContent = diff.slice(0, config.maxDiffSize);
			diffTruncated = true;
			console.log(`    Diff truncated (${diff.length} bytes)`);
		}

		// Build fixture commit
		const fixtureCommit: FixtureCommit = {
			sha: commit.sha,
			message: commit.commit.message,
			user: userLogin,
			timestamp: commit.commit.author?.date || new Date().toISOString(),
			author,
			files,
			diff: diffContent,
			diffSize: diff.length,
			diffTruncated,
			filterResult,
		};

		// Group by date
		const date = fixtureCommit.timestamp.split("T")[0] || dateRange.start;
		if (!commitsByDate.has(date)) {
			commitsByDate.set(date, []);
		}
		commitsByDate.get(date)?.push(fixtureCommit);
	}

	// Write daily fixtures
	for (const [date, dateCommits] of commitsByDate) {
		const dailyFixture: DailyFixture = {
			date,
			commits: dateCommits,
		};

		const filepath = join(repoDir, `${date}.json`);
		writeFileSync(filepath, JSON.stringify(dailyFixture, null, "\t"));
		console.log(`  Wrote ${filepath} (${dateCommits.length} commits)`);
	}

	// Write metadata
	const metadata: RepoMetadata = {
		repo: repoFullName,
		fetchedAt: new Date().toISOString(),
		dateRange,
		stats: {
			totalCommits: commits.data.length,
			includedCommits: includedCount,
			excludedCommits: excludedCount,
		},
		schemaVersion: 1,
	};

	const metadataPath = join(repoDir, "metadata.json");
	writeFileSync(metadataPath, JSON.stringify(metadata, null, "\t"));
	console.log(`  Wrote ${metadataPath}`);

	console.log(`  Done: ${includedCount} included, ${excludedCount} excluded`);
}

async function main(): Promise<void> {
	const args = parseCliArgs();

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	// Check for GitHub token
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.error("Error: GITHUB_TOKEN environment variable is required");
		process.exit(1);
	}

	const octokit = new Octokit({ auth: token });
	const config = loadConfig();

	// Override date range from CLI
	const dateRange = {
		start: args.from || config.dateRange.start,
		end: args.to || config.dateRange.end,
	};

	// Filter repos if specified
	let repos = config.repos;
	if (args.repo) {
		const [owner, repoName] = args.repo.split("/");
		if (!owner || !repoName) {
			console.error("Error: Invalid repo format. Use owner/repo");
			process.exit(1);
		}
		repos = [{ owner, repo: repoName }];
	}

	console.log("E2E Fixture Collection");
	console.log("======================");

	for (const { owner, repo } of repos) {
		try {
			await collectRepoFixtures(octokit, owner, repo, dateRange, config);
		} catch (error) {
			console.error(`Error collecting fixtures for ${owner}/${repo}:`, error);
			process.exit(1);
		}
	}

	console.log("\nFixture collection complete!");
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});

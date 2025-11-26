/**
 * TypeScript interfaces for E2E test fixtures.
 * These define the schema for persisted commit data from GitHub.
 */

/**
 * Metadata about a repository fixture collection.
 */
export interface RepoMetadata {
	repo: string; // "owner/repo" format
	fetchedAt: string; // ISO timestamp
	dateRange: {
		start: string; // YYYY-MM-DD
		end: string; // YYYY-MM-DD
	};
	stats: {
		totalCommits: number;
		includedCommits: number;
		excludedCommits: number;
	};
	schemaVersion: number; // For future migrations
}

/**
 * Author information for a commit.
 */
export interface CommitAuthor {
	name: string;
	email: string;
	username: string | null;
}

/**
 * Files changed in a commit.
 */
export interface CommitFiles {
	added: string[];
	modified: string[];
	removed: string[];
}

/**
 * Result of applying commit filters.
 */
export interface FilterResult {
	included: boolean;
	excludeReason?: "bot" | "merge" | "lockfile-only";
}

/**
 * A single commit with pre-fetched diff.
 */
export interface FixtureCommit {
	sha: string;
	message: string;
	user: string; // GitHub username or author name
	timestamp: string; // ISO timestamp
	author: CommitAuthor;
	files: CommitFiles;
	diff: string; // Pre-fetched diff content
	diffSize: number; // Size in bytes
	diffTruncated: boolean; // True if diff was > 100KB and truncated
	filterResult: FilterResult;
}

/**
 * Daily fixture containing all commits for a specific date.
 */
export interface DailyFixture {
	date: string; // YYYY-MM-DD
	commits: FixtureCommit[];
}

/**
 * Configuration for fixture collection.
 */
export interface CollectionConfig {
	repos: Array<{
		owner: string;
		repo: string;
	}>;
	dateRange: {
		start: string; // YYYY-MM-DD
		end: string; // YYYY-MM-DD
	};
	maxCommitsPerRepo: number;
	maxDiffSize: number; // Bytes, matches MAX_DIFF_SIZE in worker.ts
	rateLimitDelayMs: number;
}

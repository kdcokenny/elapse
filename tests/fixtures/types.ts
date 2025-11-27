/**
 * TypeScript interfaces for E2E test fixtures.
 * These define the schema for persisted commit data from GitHub.
 */

import type { PRBlocker } from "../../src/core/blockers";
import type { StoredTranslation } from "../../src/redis";

// Re-export for convenience
export type { PRBlocker, StoredTranslation };

/**
 * PR comment for fixture.
 */
export interface FixturePRComment {
	id: number;
	body: string;
	author: string;
	createdAt: string;
}

/**
 * PR review for fixture.
 */
export interface FixturePRReview {
	id: number;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
	author: string;
	body?: string;
}

/**
 * PR data associated with a commit or standalone.
 */
export interface FixturePR {
	number: number;
	title: string;
	state: "open" | "closed";
	draft: boolean;
	merged: boolean;
	branch: string;
	baseBranch: string;
	author: string;
	body: string | null;
	labels: string[];
	requestedReviewers: string[];
	reviews: FixturePRReview[];
	comments: FixturePRComment[];
	htmlUrl: string;
}

/**
 * Standalone PR fixture (for comment analysis testing).
 */
export interface PRFixture {
	pr: FixturePR;
	expectedBlockers?: Array<{
		type: string;
		description: string;
	}>;
}

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
	associatedPR?: FixturePR; // PR data if commit is part of a PR
}

/**
 * Daily fixture containing all commits for a specific date.
 */
export interface DailyFixture {
	date: string; // YYYY-MM-DD
	commits: FixtureCommit[];
	prs?: PRFixture[]; // Standalone PR fixtures for the day
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
	prCollection?: {
		enabled: boolean;
		maxCommentsPerPR: number;
		maxReviewsPerPR: number;
	};
}

// =============================================================================
// Feature-Centric Report Types
// =============================================================================

/**
 * Feature summary for the shipped section of reports.
 * One PR = One Feature (human-readable, business-focused).
 */
export interface FeatureSummary {
	featureName: string; // AI-generated headline (e.g., "Improved checkout flow")
	impact: string; // Business value subline (e.g., "Fixed payment validation")
	prNumber: number; // For traceability
	authors: string[]; // Contributors
	commitCount: number;
}

// =============================================================================
// Production-Aligned Fixture Types
// =============================================================================

/**
 * Production-aligned day fixture that matches getAllForDate() output.
 * This ensures E2E tests validate the actual production code paths.
 */
export interface ProductionDayFixture {
	/** Shipped translations grouped by user (matches Redis storage). */
	shipped: Record<string, StoredTranslation[]>;
	/** In-progress translations grouped by user (matches Redis storage). */
	progress: Record<string, StoredTranslation[]>;
	/** Blockers for the day (matches PRBlocker[]). */
	blockers: PRBlocker[];
	/** Expected outcomes for assertions. */
	expectations: DayExpectations;
	/** Mock AI responses for narrateFeature() - keyed by PR number. */
	featureNarrations?: Record<number, { featureName: string; impact: string }>;
	/** PR numbers that merged on this day (triggers resolveBlockersForPR). */
	mergedPRs?: number[];
}

// =============================================================================
// Work Week Scenario Types (Multi-Day Testing)
// =============================================================================

/**
 * Days of the work week for multi-day scenarios.
 */
export type WorkDay =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday";

/**
 * Configuration for a single day in a work week scenario.
 * All data is inline synthetic - manually crafted based on real repos.
 */
export interface WorkWeekDay {
	/** Commits for this day (fully inline). */
	commits: FixtureCommit[];
	/** PRs active on this day (for blocker detection). */
	activePRs?: FixturePR[];
}

/**
 * Expected outcomes for a day (for test assertions).
 */
export interface DayExpectations {
	totalCommits: number;
	blockers: {
		count: number;
		branches: string[];
		types: string[];
	};
	shipped: {
		featureCount: number;
		featureNames?: string[];
	};
	inProgress: {
		branchCount: number;
		branches: string[];
	};
}

/**
 * A complete work week scenario for multi-day E2E testing.
 */
export interface WorkWeekScenario {
	id: string;
	name: string;
	description: string;
	days: Record<WorkDay, WorkWeekDay>;
	expectations: Record<WorkDay, DayExpectations>;
}

/**
 * Master index for work week scenarios.
 */
export interface WorkWeekScenariosIndex {
	scenarios: Array<{
		id: string;
		name: string;
		description: string;
		path: string; // Relative path to scenario directory
	}>;
}

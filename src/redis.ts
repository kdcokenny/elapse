import Redis from "ioredis";
import { logger } from "./logger";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Default production Redis client
const productionRedis = new Redis(REDIS_URL, {
	maxRetriesPerRequest: null, // Required for BullMQ
	enableReadyCheck: true,

	retryStrategy: (times: number) => {
		if (times > 10) {
			logger.error("Redis connection failed after 10 retries");
			return null; // Stop retrying
		}
		const delay = Math.min(Math.exp(times) * 100, 20000);
		logger.warn({ attempt: times, delayMs: delay }, "Redis reconnecting");
		return delay;
	},
});

// Log connection events
productionRedis.on("connect", () => logger.info("Redis connected"));
productionRedis.on("ready", () => logger.info("Redis ready"));
productionRedis.on("error", (err) => logger.error({ err }, "Redis error"));
productionRedis.on("close", () => logger.warn("Redis connection closed"));
productionRedis.on("reconnecting", () => logger.info("Redis reconnecting"));

// Allow injection of mock Redis for testing
let currentRedis: Redis = productionRedis;

/**
 * Get the current Redis client (production or test mock).
 */
export function getRedis(): Redis {
	return currentRedis;
}

/**
 * Set a custom Redis client (for testing with ioredis-mock).
 * Returns a cleanup function to restore the original client.
 */
export function setRedisClient(client: Redis): () => void {
	const original = currentRedis;
	currentRedis = client;
	return () => {
		currentRedis = original;
	};
}

// Export for backwards compatibility (BullMQ needs direct access)
export const redis = productionRedis;

// Redis key helpers

const KEY_PREFIX = "elapse";

/**
 * Translation with metadata for storage.
 * Now includes structured fields from AI.
 */
export interface StoredTranslation {
	// Structured fields from AI
	summary: string;
	category: string | null;
	significance: string | null;

	// Metadata
	branch: string;
	prNumber?: number;
	prTitle?: string;
	sha: string;
}

// ============================================================================
// Report Timestamp (for "since last report" tracking)
// ============================================================================

const LAST_REPORT_KEY = `${KEY_PREFIX}:lastReportTimestamp`;

/**
 * Get the timestamp of the last successful report.
 * Returns null if no report has been sent yet.
 */
export async function getLastReportTimestamp(): Promise<string | null> {
	const client = getRedis();
	return client.get(LAST_REPORT_KEY);
}

/**
 * Store the timestamp watermark after a successful report.
 * This should be the maximum timestamp from the reported data.
 */
export async function setLastReportTimestamp(timestamp: string): Promise<void> {
	const client = getRedis();
	await client.set(LAST_REPORT_KEY, timestamp);
}

// ============================================================================
// PR-Centric Storage (New Architecture)
// ============================================================================

/**
 * TTL strategy for PR data.
 */
const PR_TTL = {
	OPEN_PR: null, // No expiry while open
	MERGED_PR: 30 * 24 * 3600, // 30 days after merge
	CLOSED_PR: 7 * 24 * 3600, // 7 days after close
	DAILY_INDEX: 7 * 24 * 3600, // 7 days
	DIRECT_COMMITS: 7 * 24 * 3600, // 7 days
};

/**
 * PR metadata stored in Redis hash.
 */
export interface PRMetadata {
	repo: string;
	branch: string;
	title: string;
	authors: string[];
	status: "open" | "merged" | "closed";
	openedAt: string;
	closedAt?: string;
	mergedAt?: string;
}

/**
 * Translation stored per PR.
 */
export interface PRTranslation {
	sha: string;
	summary: string;
	category: string | null;
	significance: string | null;
	author: string;
	timestamp: string;
}

/**
 * Blocker stored per PR with keyed access.
 */
export interface PRBlockerEntry {
	type:
		| "changes_requested"
		| "pending_review"
		| "comment"
		| "label"
		| "description"
		| "stale_review";
	description: string;
	reviewer?: string;
	commentId?: number;
	detectedAt: string;
	resolvedAt?: string;
	/** GitHub usernames mentioned as blockers (Layer 2: AI @mention extraction) */
	mentionedUsers?: string[];
}

// Key generators for PR-centric storage
function prMetadataKey(prNumber: number): string {
	return `${KEY_PREFIX}:pr:${prNumber}`;
}

function prBlockersKey(prNumber: number): string {
	return `${KEY_PREFIX}:pr:${prNumber}:blockers`;
}

function directCommitsKey(date: string): string {
	return `${KEY_PREFIX}:direct:${date}`;
}

function openPRsIndexKey(): string {
	return `${KEY_PREFIX}:open-prs`;
}

// ============================================================================
// PR Metadata Operations
// ============================================================================

/**
 * Create or update PR metadata.
 * Authors are accumulated (merged with existing).
 * Required fields (repo, branch) must be provided on create.
 */
export async function createOrUpdatePR(
	prNumber: number,
	data: Partial<PRMetadata>,
): Promise<void> {
	const client = getRedis();
	const key = prMetadataKey(prNumber);

	// Get existing data to merge authors (returns null if not found, throws if corrupted)
	let existing: PRMetadata | null = null;
	try {
		existing = await getPRMetadata(prNumber);
	} catch {
		// Corrupted data - we'll overwrite it
		existing = null;
	}

	// Resolve required fields
	const repo = data.repo ?? existing?.repo;
	const branch = data.branch ?? existing?.branch;

	if (!repo || !branch) {
		throw new Error(
			`Cannot create PR #${prNumber}: missing required fields (repo, branch)`,
		);
	}

	// Accumulate authors
	const authors = new Set<string>(existing?.authors ?? []);
	for (const author of data.authors ?? []) {
		authors.add(author);
	}

	const merged: PRMetadata = {
		repo,
		branch,
		title: data.title ?? existing?.title ?? `PR #${prNumber}`,
		authors: Array.from(authors),
		status: data.status ?? existing?.status ?? "open",
		openedAt: data.openedAt ?? existing?.openedAt ?? new Date().toISOString(),
		closedAt: data.closedAt ?? existing?.closedAt,
		mergedAt: data.mergedAt ?? existing?.mergedAt,
	};

	await client.hset(key, {
		repo: merged.repo,
		branch: merged.branch,
		title: merged.title,
		authors: JSON.stringify(merged.authors),
		status: merged.status,
		openedAt: merged.openedAt,
		...(merged.closedAt && { closedAt: merged.closedAt }),
		...(merged.mergedAt && { mergedAt: merged.mergedAt }),
	});

	// No TTL for open PRs, and add to open PRs index
	if (merged.status === "open") {
		await client.persist(key);
		await client.sadd(openPRsIndexKey(), prNumber.toString());
	}
}

/**
 * Get PR metadata.
 */
export async function getPRMetadata(
	prNumber: number,
): Promise<PRMetadata | null> {
	const client = getRedis();
	const raw = await client.hgetall(prMetadataKey(prNumber));

	if (!raw || Object.keys(raw).length === 0) {
		return null;
	}

	// Required fields - fail fast if corrupted
	if (!raw.repo || !raw.branch || !raw.status) {
		throw new Error(
			`Corrupted PR metadata for PR #${prNumber}: missing required fields`,
		);
	}

	return {
		repo: raw.repo,
		branch: raw.branch,
		title: raw.title ?? `PR #${prNumber}`,
		authors: raw.authors ? JSON.parse(raw.authors) : [],
		status: raw.status as PRMetadata["status"],
		openedAt: raw.openedAt ?? new Date().toISOString(),
		closedAt: raw.closedAt,
		mergedAt: raw.mergedAt,
	};
}

/**
 * Set PR status and apply appropriate TTL.
 */
export async function setPRStatus(
	prNumber: number,
	status: "open" | "merged" | "closed",
	timestamp?: string,
): Promise<void> {
	const client = getRedis();
	const key = prMetadataKey(prNumber);
	const now = timestamp ?? new Date().toISOString();

	const updates: Record<string, string> = { status };

	if (status === "merged") {
		updates.mergedAt = now;
		updates.closedAt = now;
	} else if (status === "closed") {
		updates.closedAt = now;
	}

	await client.hset(key, updates);

	// Apply TTL based on status
	const ttl =
		status === "merged"
			? PR_TTL.MERGED_PR
			: status === "closed"
				? PR_TTL.CLOSED_PR
				: null;

	if (ttl) {
		await client.expire(key, ttl);
		// Also set TTL on blockers
		await client.expire(prBlockersKey(prNumber), ttl);
		// Remove from open PRs index
		await client.srem(openPRsIndexKey(), prNumber.toString());
	} else {
		await client.persist(key);
		// Add to open PRs index
		await client.sadd(openPRsIndexKey(), prNumber.toString());
	}
}

// ============================================================================
// PR Blockers Operations
// ============================================================================

/**
 * Set a blocker for a PR.
 * Key format: "review:{reviewer}" or "comment:{commentId}" or "label:{name}"
 */
export async function setPRBlocker(
	prNumber: number,
	blockerKey: string,
	blocker: PRBlockerEntry,
): Promise<void> {
	const client = getRedis();
	const key = prBlockersKey(prNumber);
	await client.hset(key, blockerKey, JSON.stringify(blocker));
}

/**
 * Mark a blocker as resolved by setting resolvedAt timestamp.
 * This preserves the blocker for historical tracking until cleanup runs.
 * Returns true if the blocker existed and was updated.
 */
export async function resolvePRBlocker(
	prNumber: number,
	blockerKey: string,
): Promise<boolean> {
	const client = getRedis();
	const key = prBlockersKey(prNumber);

	const existing = await client.hget(key, blockerKey);
	if (!existing) return false;

	const blocker = JSON.parse(existing) as PRBlockerEntry;
	blocker.resolvedAt = new Date().toISOString();

	await client.hset(key, blockerKey, JSON.stringify(blocker));
	return true;
}

/**
 * Get all blockers for a PR.
 */
export async function getPRBlockers(
	prNumber: number,
): Promise<Map<string, PRBlockerEntry>> {
	const client = getRedis();
	const raw = await client.hgetall(prBlockersKey(prNumber));
	const result = new Map<string, PRBlockerEntry>();

	for (const [key, value] of Object.entries(raw)) {
		result.set(key, JSON.parse(value) as PRBlockerEntry);
	}

	return result;
}

/** TTL for resolved blockers before cleanup (7 days) */
const RESOLVED_BLOCKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cleanup resolved blockers older than 7 days.
 * Called after daily report to prevent blocker accumulation.
 * Returns count of deleted entries.
 */
export async function cleanupResolvedBlockers(): Promise<number> {
	const client = getRedis();
	const cutoff = Date.now() - RESOLVED_BLOCKER_TTL_MS;
	let deletedCount = 0;

	// Get all open PR numbers
	const prNumbers = await client.smembers(openPRsIndexKey());

	for (const prNumStr of prNumbers) {
		const prNumber = Number.parseInt(prNumStr, 10);
		const key = prBlockersKey(prNumber);
		const raw = await client.hgetall(key);

		for (const [blockerKey, value] of Object.entries(raw)) {
			const blocker = JSON.parse(value) as PRBlockerEntry;
			if (blocker.resolvedAt) {
				const resolvedTime = new Date(blocker.resolvedAt).getTime();
				if (resolvedTime < cutoff) {
					await client.hdel(key, blockerKey);
					deletedCount++;
				}
			}
		}
	}

	return deletedCount;
}

// ============================================================================
// Daily Index Operations
// ============================================================================

/**
 * Key for merged PRs on a given day.
 */
function dayMergedPRsKey(date: string): string {
	return `${KEY_PREFIX}:day:${date}:prs:merged`;
}

/**
 * Record that a PR was merged on a given day.
 * Called when PR is closed with merged=true.
 */
export async function recordPRMerged(
	prNumber: number,
	date: string,
): Promise<void> {
	const client = getRedis();
	const key = dayMergedPRsKey(date);
	await client.sadd(key, prNumber.toString());
	await client.expire(key, 30 * 24 * 3600); // 30 days
}

/**
 * Get all PR numbers merged on a given day.
 */
export async function getMergedPRsForDay(date: string): Promise<number[]> {
	const client = getRedis();
	const raw = await client.smembers(dayMergedPRsKey(date));
	return raw.map((r) => parseInt(r, 10));
}

/**
 * Get all open PR numbers from the index.
 */
export async function getAllOpenPRNumbers(): Promise<number[]> {
	const client = getRedis();
	const raw = await client.smembers(openPRsIndexKey());
	return raw.map((r) => parseInt(r, 10));
}

// ============================================================================
// Direct Commits (No PR)
// ============================================================================

/**
 * Store a direct commit (no associated PR).
 */
export async function addDirectCommit(
	date: string,
	translation: StoredTranslation,
): Promise<void> {
	const client = getRedis();
	const key = directCommitsKey(date);
	await client.rpush(key, JSON.stringify(translation));
	await client.expire(key, PR_TTL.DIRECT_COMMITS);
}

/**
 * Get direct commits for a date.
 */
export async function getDirectCommits(
	date: string,
): Promise<StoredTranslation[]> {
	const client = getRedis();
	const raw = await client.lrange(directCommitsKey(date), 0, -1);
	return raw.map((r) => JSON.parse(r) as StoredTranslation);
}

// ============================================================================
// Branch Commits Storage (Branch-First Architecture)
// ============================================================================

/**
 * Commit stored per branch.
 * Commits are stored by branch and resolved to PRs at read time.
 */
export interface BranchCommit {
	sha: string;
	summary: string;
	category: string | null;
	significance: string | null;
	author: string;
	timestamp: string;
}

/**
 * Key for branch commits.
 * Format: elapse:branch:{repo}:{branch}:commits
 */
function branchCommitsKey(repo: string, branch: string): string {
	return `${KEY_PREFIX}:branch:${repo}:${branch}:commits`;
}

/**
 * Add a commit to branch storage.
 * No TTL - cleanup is handled by background job.
 */
export async function addBranchCommit(
	repo: string,
	branch: string,
	commit: BranchCommit,
): Promise<void> {
	const client = getRedis();
	const key = branchCommitsKey(repo, branch);
	await client.rpush(key, JSON.stringify(commit));
	// No TTL - data persists until explicit cleanup
}

/**
 * Get all commits for a branch.
 */
export async function getBranchCommits(
	repo: string,
	branch: string,
): Promise<BranchCommit[]> {
	const client = getRedis();
	const raw = await client.lrange(branchCommitsKey(repo, branch), 0, -1);
	return raw.map((r) => JSON.parse(r) as BranchCommit);
}

/**
 * Get commits for a branch filtered for a PR.
 * For merged PRs: returns commits where timestamp <= mergedAt
 * For open PRs: returns all commits (no filter)
 */
export async function getBranchCommitsForPR(
	repo: string,
	branch: string,
	mergedAt?: string,
): Promise<BranchCommit[]> {
	const commits = await getBranchCommits(repo, branch);
	if (!mergedAt) {
		return commits; // Open PR - return all
	}
	return commits.filter((c) => c.timestamp <= mergedAt);
}

/**
 * Delete all commits for a branch.
 * Called by cleanup job for stale branches.
 */
export async function deleteBranchCommits(
	repo: string,
	branch: string,
): Promise<void> {
	const client = getRedis();
	await client.del(branchCommitsKey(repo, branch));
}

/**
 * Get all branch commit keys for cleanup iteration.
 * Returns keys matching elapse:branch:*:commits pattern.
 */
export async function getAllBranchKeys(): Promise<string[]> {
	const client = getRedis();
	return client.keys(`${KEY_PREFIX}:branch:*:commits`);
}

/**
 * Parse a branch key to extract repo and branch.
 * Key format: elapse:branch:{repo}:{branch}:commits
 */
export function parseBranchKey(
	key: string,
): { repo: string; branch: string } | null {
	const match = key.match(/^elapse:branch:(.+?):(.+?):commits$/);
	if (!match) return null;
	// Handle repo format "owner/reponame" - the branch is everything after repo
	const parts = key
		.replace(`${KEY_PREFIX}:branch:`, "")
		.replace(":commits", "")
		.split(":");
	if (parts.length < 2) return null;
	// First two parts are owner/repo, rest is branch
	const repo = `${parts[0]}/${parts[1]}`;
	const branch = parts.slice(2).join(":");
	return { repo, branch };
}

// ============================================================================
// Lifecycle Management
// ============================================================================

/**
 * Close a PR (merged or closed without merge).
 * Sets status, applies TTL, and cleans up blockers for closed PRs.
 */
export async function closePR(
	prNumber: number,
	merged: boolean,
): Promise<void> {
	const status = merged ? "merged" : "closed";
	await setPRStatus(prNumber, status);

	// For closed (not merged) PRs, remove all blockers immediately
	if (!merged) {
		const client = getRedis();
		await client.del(prBlockersKey(prNumber));
	}
}

// ============================================================================
// Aggregation for Reports
// ============================================================================

/**
 * PR data aggregated for reporting.
 */
export interface PRReportData {
	meta: PRMetadata;
	translations: PRTranslation[];
	blockers: Map<string, PRBlockerEntry>;
	/** Whether this PR had commits today */
	hasActivityToday: boolean;
}

/**
 * Get all dates between two timestamps (inclusive).
 * Used to query all day indexes in a "since last report" range.
 */
function getDateRange(sinceTimestamp: string, endDate: string): string[] {
	const dates: string[] = [];
	const start = new Date(sinceTimestamp);
	const end = new Date(`${endDate}T23:59:59.999Z`);

	// Normalize to date-only by extracting YYYY-MM-DD
	const startDateStr = start.toISOString().slice(0, 10);
	const current = new Date(startDateStr);

	while (current <= end) {
		dates.push(current.toISOString().slice(0, 10));
		current.setDate(current.getDate() + 1);
	}

	return dates;
}

/**
 * Get all PR data for reporting using branch-first read-time resolution.
 *
 * Architecture: Commits are stored by branch, PRs store metadata with branch reference.
 * At report time, we resolve PR→branch→commits relationships.
 *
 * Returns ALL open PRs, merged PRs (since timestamp), and direct commits.
 */
export async function getAllPRDataForDate(
	date: string,
	sinceTimestamp?: string,
): Promise<{
	openPRs: Map<number, PRReportData>;
	mergedPRs: Map<number, PRReportData & { blockersResolved: string[] }>;
	directCommits: StoredTranslation[];
}> {
	// Get all open PRs
	const allOpenPRs = await getAllOpenPRNumbers();

	// Get merged PRs in date range
	let mergedPRNumbers: number[];
	if (sinceTimestamp) {
		const dateRange = getDateRange(sinceTimestamp, date);
		const mergedSets = await Promise.all(
			dateRange.map((d) => getMergedPRsForDay(d)),
		);
		mergedPRNumbers = [...new Set(mergedSets.flat())];
	} else {
		mergedPRNumbers = await getMergedPRsForDay(date);
	}

	// Union of all PR numbers we need to fetch
	const allPRNumbers = [...new Set([...allOpenPRs, ...mergedPRNumbers])];

	// Fetch PR metadata and blockers in parallel
	const prDataPromises = allPRNumbers.map(async (prNumber) => {
		const [meta, blockers] = await Promise.all([
			getPRMetadata(prNumber),
			getPRBlockers(prNumber),
		]);
		return { prNumber, meta, blockers };
	});

	const prDataResults = await Promise.all(prDataPromises);
	const directCommits = await getDirectCommits(date);

	const openPRs = new Map<number, PRReportData>();
	const mergedPRs = new Map<
		number,
		PRReportData & { blockersResolved: string[] }
	>();

	// Read-time resolution: For each PR, fetch commits from branch storage
	for (const { prNumber, meta, blockers } of prDataResults) {
		if (!meta) continue;

		// Get commits from branch storage (read-time resolution)
		const branchCommits = await getBranchCommitsForPR(
			meta.repo,
			meta.branch,
			meta.mergedAt, // For merged PRs, filter commits <= mergedAt
		);

		// Convert BranchCommit to PRTranslation format
		const translations: PRTranslation[] = branchCommits.map((c) => ({
			sha: c.sha,
			summary: c.summary,
			category: c.category,
			significance: c.significance,
			author: c.author,
			timestamp: c.timestamp,
		}));

		// Filter by report window
		const filteredTranslations = sinceTimestamp
			? translations.filter((t) => t.timestamp >= sinceTimestamp)
			: translations.filter((t) => t.timestamp.startsWith(date));

		// Check for activity today
		const hasActivityToday = translations.some((t) =>
			t.timestamp.startsWith(date),
		);

		// Check if merged since last report
		const isMergedInWindow = sinceTimestamp
			? meta.status === "merged" &&
				meta.mergedAt &&
				meta.mergedAt >= sinceTimestamp
			: meta.status === "merged" && meta.mergedAt?.startsWith(date);

		if (isMergedInWindow) {
			const blockersResolved = Array.from(blockers.values())
				.filter((b) => b.resolvedAt)
				.map((b) => b.description);

			mergedPRs.set(prNumber, {
				meta,
				translations, // All translations for merged PR
				blockers,
				hasActivityToday,
				blockersResolved,
			});
		} else if (meta.status === "open") {
			openPRs.set(prNumber, {
				meta,
				translations: filteredTranslations,
				blockers,
				hasActivityToday,
			});
		}
	}

	return { openPRs, mergedPRs, directCommits };
}

import Redis from "ioredis";
import type { PRBlocker } from "./core/blockers";
import type { WorkSection } from "./core/branches";
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
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

/**
 * Generate key for daily translations list with section.
 * Format: elapse:day:{YYYY-MM-DD}:{username}:{section}
 */
export function dayKey(
	date: string,
	user: string,
	section: WorkSection,
): string {
	return `${KEY_PREFIX}:day:${date}:${user}:${section}`;
}

/**
 * Generate key for daily blockers.
 * Format: elapse:day:{YYYY-MM-DD}:blockers
 */
export function blockersKey(date: string): string {
	return `${KEY_PREFIX}:day:${date}:blockers`;
}

/**
 * Store a translation for a user on a given date in a specific section.
 * Note: Caller should check for action: "skip" before calling.
 */
export async function storeTranslation(
	date: string,
	user: string,
	section: WorkSection,
	translation: StoredTranslation,
): Promise<void> {
	const key = dayKey(date, user, section);
	const client = getRedis();
	await client.rpush(key, JSON.stringify(translation));
	await client.expire(key, TTL_SECONDS);
}

/**
 * Store blockers for a given date.
 * Uses a hash to deduplicate by branch+type.
 */
export async function storeBlockers(
	date: string,
	blockers: PRBlocker[],
): Promise<void> {
	if (blockers.length === 0) return;

	const key = blockersKey(date);
	const client = getRedis();

	// Deduplicate by branch+type (only keep latest per branch)
	for (const blocker of blockers) {
		const id = `${blocker.branch}:${blocker.type}`;
		await client.hset(key, id, JSON.stringify(blocker));
	}

	await client.expire(key, TTL_SECONDS);
}

/**
 * Get all translations for a user on a given date in a specific section.
 */
export async function getTranslations(
	date: string,
	user: string,
	section: WorkSection,
): Promise<StoredTranslation[]> {
	const client = getRedis();
	const raw = await client.lrange(dayKey(date, user, section), 0, -1);
	return raw.map((r) => JSON.parse(r) as StoredTranslation);
}

/**
 * Get all blockers for a given date.
 */
export async function getBlockersForDate(date: string): Promise<PRBlocker[]> {
	const key = blockersKey(date);
	const client = getRedis();
	const raw = await client.hgetall(key);
	return Object.values(raw).map((r) => JSON.parse(r) as PRBlocker);
}

/**
 * Get all users who have translations for a given date in a specific section.
 */
export async function getUsersForSection(
	date: string,
	section: WorkSection,
): Promise<string[]> {
	const pattern = `${KEY_PREFIX}:day:${date}:*:${section}`;
	const client = getRedis();
	const keys = await client.keys(pattern);
	// Extract username from key: elapse:day:{date}:{user}:{section}
	return keys
		.map((k) => {
			const parts = k.split(":");
			return parts[3] ?? "";
		})
		.filter((u) => u.length > 0);
}

/**
 * Get all data for a given date (shipped, progress, blockers).
 * Includes both date-based blockers and persistent blockers from PR comments.
 */
export async function getAllForDate(date: string): Promise<{
	shipped: Map<string, StoredTranslation[]>;
	progress: Map<string, StoredTranslation[]>;
	blockers: PRBlocker[];
}> {
	const [shippedUsers, progressUsers, dateBlockers, persistentBlockers] =
		await Promise.all([
			getUsersForSection(date, "shipped"),
			getUsersForSection(date, "progress"),
			getBlockersForDate(date),
			getActivePersistentBlockers(),
		]);

	// Merge date-based and persistent blockers
	const blockers = [...dateBlockers, ...persistentBlockers];

	const shipped = new Map<string, StoredTranslation[]>();
	const progress = new Map<string, StoredTranslation[]>();

	// Fetch all translations in parallel
	const shippedPromises = shippedUsers.map(async (user) => {
		const translations = await getTranslations(date, user, "shipped");
		return { user, translations };
	});

	const progressPromises = progressUsers.map(async (user) => {
		const translations = await getTranslations(date, user, "progress");
		return { user, translations };
	});

	const [shippedResults, progressResults] = await Promise.all([
		Promise.all(shippedPromises),
		Promise.all(progressPromises),
	]);

	for (const { user, translations } of shippedResults) {
		shipped.set(user, translations);
	}

	for (const { user, translations } of progressResults) {
		progress.set(user, translations);
	}

	return { shipped, progress, blockers };
}

// Persistent blocker storage (for comment-based blockers that persist across days)

const PERSISTENT_BLOCKERS_KEY = `${KEY_PREFIX}:blockers:active`;
const PERSISTENT_BLOCKERS_TTL = 30 * 24 * 60 * 60; // 30 days

/**
 * Store a persistent blocker (from PR comments).
 * These persist until resolved by AI or PR merge.
 */
export async function storePersistentBlocker(
	blocker: PRBlocker,
): Promise<void> {
	// Use repo:prNumber:commentId as the unique key
	const id = `${blocker.prNumber}:${blocker.commentId}`;
	const client = getRedis();
	await client.hset(PERSISTENT_BLOCKERS_KEY, id, JSON.stringify(blocker));
	await client.expire(PERSISTENT_BLOCKERS_KEY, PERSISTENT_BLOCKERS_TTL);
}

/**
 * Remove all blockers for a PR (called on merge or AI resolution).
 * Returns the number of blockers removed.
 */
export async function resolveBlockersForPR(
	_repo: string,
	prNumber: number,
): Promise<number> {
	const client = getRedis();
	const all = await client.hgetall(PERSISTENT_BLOCKERS_KEY);
	let removed = 0;

	for (const [id, _value] of Object.entries(all)) {
		// Keys are in format "prNumber:commentId"
		if (id.startsWith(`${prNumber}:`)) {
			await client.hdel(PERSISTENT_BLOCKERS_KEY, id);
			removed++;
		}
	}

	return removed;
}

/**
 * Get all active persistent blockers.
 */
export async function getActivePersistentBlockers(): Promise<PRBlocker[]> {
	const client = getRedis();
	const raw = await client.hgetall(PERSISTENT_BLOCKERS_KEY);
	return Object.values(raw).map((r) => JSON.parse(r) as PRBlocker);
}

/**
 * Store a review-based blocker (from pull_request_review events).
 * Key format: prNumber:review:reviewer
 */
export async function storeReviewBlocker(blocker: PRBlocker): Promise<void> {
	if (!blocker.reviewer) return;
	const id = `${blocker.prNumber}:review:${blocker.reviewer}`;
	const client = getRedis();
	await client.hset(PERSISTENT_BLOCKERS_KEY, id, JSON.stringify(blocker));
	await client.expire(PERSISTENT_BLOCKERS_KEY, PERSISTENT_BLOCKERS_TTL);
}

/**
 * Remove a review blocker for a specific reviewer on a PR.
 * Called when a reviewer approves or their review is dismissed.
 */
export async function resolveReviewBlocker(
	prNumber: number,
	reviewer: string,
): Promise<boolean> {
	const id = `${prNumber}:review:${reviewer}`;
	const client = getRedis();
	const removed = await client.hdel(PERSISTENT_BLOCKERS_KEY, id);
	return removed > 0;
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
		| "description";
	description: string;
	reviewer?: string;
	commentId?: number;
	detectedAt: string;
	resolvedAt?: string;
}

// Key generators for PR-centric storage
function prMetadataKey(prNumber: number): string {
	return `${KEY_PREFIX}:pr:${prNumber}`;
}

function prTranslationsKey(prNumber: number): string {
	return `${KEY_PREFIX}:pr:${prNumber}:translations`;
}

function prBlockersKey(prNumber: number): string {
	return `${KEY_PREFIX}:pr:${prNumber}:blockers`;
}

function dayPRsKey(date: string): string {
	return `${KEY_PREFIX}:day:${date}:prs`;
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
		// Also set TTL on related keys
		await client.expire(prTranslationsKey(prNumber), ttl);
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
// PR Translations Operations
// ============================================================================

/**
 * Add a translation to a PR.
 */
export async function addPRTranslation(
	prNumber: number,
	translation: PRTranslation,
): Promise<void> {
	const client = getRedis();
	const key = prTranslationsKey(prNumber);
	await client.rpush(key, JSON.stringify(translation));
	// No TTL - inherits from PR metadata status
}

/**
 * Get all translations for a PR.
 */
export async function getPRTranslations(
	prNumber: number,
): Promise<PRTranslation[]> {
	const client = getRedis();
	const raw = await client.lrange(prTranslationsKey(prNumber), 0, -1);
	return raw.map((r) => JSON.parse(r) as PRTranslation);
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
 * Remove a blocker from a PR.
 */
export async function removePRBlocker(
	prNumber: number,
	blockerKey: string,
): Promise<boolean> {
	const client = getRedis();
	const removed = await client.hdel(prBlockersKey(prNumber), blockerKey);
	return removed > 0;
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

// ============================================================================
// Daily Index Operations
// ============================================================================

/**
 * Add a PR to a day's activity index.
 */
export async function addPRToDay(
	date: string,
	prNumber: number,
): Promise<void> {
	const client = getRedis();
	const key = dayPRsKey(date);
	await client.sadd(key, prNumber.toString());
	await client.expire(key, PR_TTL.DAILY_INDEX);
}

/**
 * Get all PR numbers with activity on a given day.
 */
export async function getPRsForDay(date: string): Promise<number[]> {
	const client = getRedis();
	const raw = await client.smembers(dayPRsKey(date));
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
 * Get all PR data for reporting.
 * When sinceTimestamp is provided, returns activity since that timestamp (for "since last report").
 * Otherwise, returns activity for the given date only (legacy behavior).
 *
 * Returns ALL open PRs (regardless of daily activity), merged PRs (since timestamp), and direct commits.
 */
export async function getAllPRDataForDate(
	date: string,
	sinceTimestamp?: string,
): Promise<{
	openPRs: Map<number, PRReportData>;
	mergedPRs: Map<number, PRReportData & { blockersResolved: string[] }>;
	directCommits: StoredTranslation[];
}> {
	// Get PRs with activity in the reporting window
	let prsWithActivity: number[];

	if (sinceTimestamp) {
		// Query all days from sinceTimestamp to date
		const dateRange = getDateRange(sinceTimestamp, date);
		const prSets = await Promise.all(dateRange.map((d) => getPRsForDay(d)));
		prsWithActivity = [...new Set(prSets.flat())];
	} else {
		prsWithActivity = await getPRsForDay(date);
	}

	// Also include all open PRs (regardless of daily activity)
	const allOpenPRs = await getAllOpenPRNumbers();

	// Create a set of PRs with activity for quick lookup
	const activitySet = new Set(prsWithActivity);

	// Union of all PR numbers we need to fetch
	const allPRNumbers = [...new Set([...prsWithActivity, ...allOpenPRs])];

	// Fetch all PR data in parallel
	const prDataPromises = allPRNumbers.map(async (prNumber) => {
		const [meta, translations, blockers] = await Promise.all([
			getPRMetadata(prNumber),
			getPRTranslations(prNumber),
			getPRBlockers(prNumber),
		]);
		return { prNumber, meta, translations, blockers };
	});

	const prDataResults = await Promise.all(prDataPromises);
	const directCommits = await getDirectCommits(date);

	const openPRs = new Map<number, PRReportData>();
	const mergedPRs = new Map<
		number,
		PRReportData & { blockersResolved: string[] }
	>();

	for (const { prNumber, meta, translations, blockers } of prDataResults) {
		if (!meta) continue;

		// Filter translations: since timestamp if provided, otherwise by date
		const filteredTranslations = sinceTimestamp
			? translations.filter((t) => t.timestamp >= sinceTimestamp)
			: translations.filter((t) => t.timestamp.startsWith(date));

		const hasActivityToday = activitySet.has(prNumber);

		// Check if merged since last report (or today if no timestamp)
		const isMergedInWindow = sinceTimestamp
			? meta.status === "merged" &&
				meta.mergedAt &&
				meta.mergedAt >= sinceTimestamp
			: meta.status === "merged" && meta.mergedAt?.startsWith(date);

		if (isMergedInWindow) {
			// Merged in reporting window - include all translations and note resolved blockers
			const blockersResolved = Array.from(blockers.values())
				.filter((b) => b.resolvedAt)
				.map((b) => b.description);

			mergedPRs.set(prNumber, {
				meta,
				translations, // All translations, not just window's
				blockers,
				hasActivityToday,
				blockersResolved,
			});
		} else if (meta.status === "open") {
			// All open PRs - include regardless of daily activity
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

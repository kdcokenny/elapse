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

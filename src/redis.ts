import Redis from "ioredis";
import { logger } from "./logger";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(REDIS_URL, {
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
redis.on("connect", () => logger.info("Redis connected"));
redis.on("ready", () => logger.info("Redis ready"));
redis.on("error", (err) => logger.error({ error: err }, "Redis error"));
redis.on("close", () => logger.warn("Redis connection closed"));
redis.on("reconnecting", () => logger.info("Redis reconnecting"));

// Redis key helpers

const KEY_PREFIX = "elapse";
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Generate key for daily translations list.
 * Format: elapse:day:{YYYY-MM-DD}:{username}
 */
export function dayKey(date: string, user: string): string {
	return `${KEY_PREFIX}:day:${date}:${user}`;
}

/**
 * Store a translation for a user on a given date.
 */
export async function storeTranslation(
	date: string,
	user: string,
	translation: string,
): Promise<void> {
	if (translation === "SKIP") return;

	const key = dayKey(date, user);
	await redis.rpush(key, translation);
	await redis.expire(key, TTL_SECONDS);
}

/**
 * Get all translations for a user on a given date.
 */
export async function getTranslations(
	date: string,
	user: string,
): Promise<string[]> {
	return redis.lrange(dayKey(date, user), 0, -1);
}

/**
 * Get all users who have translations for a given date.
 */
export async function getUsersForDate(date: string): Promise<string[]> {
	const pattern = `${KEY_PREFIX}:day:${date}:*`;
	const keys = await redis.keys(pattern);
	return keys.map((k) => k.split(":").at(-1) ?? "");
}

/**
 * Get all translations for all users on a given date.
 */
export async function getAllTranslationsForDate(
	date: string,
): Promise<Map<string, string[]>> {
	const users = await getUsersForDate(date);
	const result = new Map<string, string[]>();

	for (const user of users) {
		result.set(user, await getTranslations(date, user));
	}

	return result;
}

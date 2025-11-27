/**
 * Test Redis module using ioredis-mock for E2E testing.
 * Provides a mock Redis instance that persists state across test runs.
 */

import type Redis from "ioredis";
import RedisMock from "ioredis-mock";
import { setRedisClient } from "../../src/redis";

// Single mock instance that persists across the test run
export const testRedis = new RedisMock() as unknown as Redis;

// Track cleanup function
let cleanup: (() => void) | null = null;

/**
 * Initialize the test Redis mock.
 * Call this in beforeAll() to inject the mock client.
 */
export function initTestRedis(): void {
	cleanup = setRedisClient(testRedis);
}

/**
 * Reset all data in the test Redis.
 * Call this between test runs to start with a clean slate.
 */
export async function resetTestRedis(): Promise<void> {
	await testRedis.flushall();
}

/**
 * Restore the original Redis client.
 * Call this in afterAll() to clean up.
 */
export function restoreRedis(): void {
	if (cleanup) {
		cleanup();
		cleanup = null;
	}
}

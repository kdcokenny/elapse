/**
 * Health check route handler.
 */

import { redis } from "../redis";

export function healthRoute(): Response {
	const redisOk = redis.status === "ready";
	const status = redisOk ? "healthy" : "unhealthy";
	return Response.json(
		{
			status,
			redis: redisOk ? "up" : "down",
			timestamp: new Date().toISOString(),
		},
		{ status: redisOk ? 200 : 503 },
	);
}

/**
 * Elapse - AI-powered standup bot
 * Entry point that wires everything together.
 */

import { Queue } from "bullmq";
import { Probot, Server } from "probot";
import { logger } from "./logger";
import { redis } from "./redis";
import { createReportWorker, setupReportScheduler } from "./reporter";
import { initShutdownHandlers, registerShutdownHandler } from "./shutdown";
import { createWebhookApp } from "./webhook";
import { createWorker, QUEUE_NAME } from "./worker";

async function main() {
	logger.info("Starting Elapse...");

	// Initialize shutdown handlers
	initShutdownHandlers();

	// Create BullMQ queue
	const queue = new Queue(QUEUE_NAME, {
		connection: redis,
		defaultJobOptions: {
			attempts: 5,
			backoff: {
				type: "exponential",
				delay: 2000,
			},
			removeOnComplete: {
				age: 86400, // 24 hours
			},
			removeOnFail: {
				age: 604800, // 7 days
			},
		},
	});

	// Register queue shutdown
	registerShutdownHandler(async () => {
		logger.info("Closing queue...");
		await queue.close();
		logger.info("Queue closed");
	});

	// Create Probot server
	const server = new Server({
		Probot: Probot.defaults({
			appId: process.env.APP_ID,
			privateKey: process.env.PRIVATE_KEY,
			secret: process.env.WEBHOOK_SECRET,
		}),
		port: parseInt(process.env.PORT || "3000", 10),
	});

	// Load webhook app
	await server.load(createWebhookApp(queue));

	// Add health endpoint
	// @ts-expect-error - accessing internal express app
	const expressApp = server.expressApp || server.probotApp?.express;
	if (expressApp) {
		expressApp.get(
			"/health",
			(
				_req: unknown,
				res: { status: (code: number) => { json: (data: unknown) => void } },
			) => {
				const redisOk = redis.status === "ready";
				const status = redisOk ? "healthy" : "unhealthy";
				const statusCode = status === "healthy" ? 200 : 503;
				res.status(statusCode).json({
					status,
					redis: redisOk ? "up" : "down",
					timestamp: new Date().toISOString(),
				});
			},
		);
	}

	// Register server shutdown
	registerShutdownHandler(async () => {
		logger.info("Stopping HTTP server...");
		await server.stop();
		logger.info("HTTP server stopped");
	});

	// Start the digest worker
	const digestWorker = createWorker();

	// Register digest worker shutdown
	registerShutdownHandler(async () => {
		logger.info("Closing digest worker...");
		await digestWorker.close();
		logger.info("Digest worker closed");
	});

	// Start the report worker
	const reportWorker = createReportWorker();

	// Register report worker shutdown
	registerShutdownHandler(async () => {
		logger.info("Closing report worker...");
		await reportWorker.close();
		logger.info("Report worker closed");
	});

	// Setup daily report scheduler
	await setupReportScheduler(queue);

	// Register Redis shutdown (last, so it closes after everything else)
	registerShutdownHandler(async () => {
		logger.info("Closing Redis connection...");
		await redis.quit();
		logger.info("Redis connection closed");
	});

	// Start the server
	await server.start();

	const port = process.env.PORT || "3000";
	logger.info({ port }, "Elapse is running");
	logger.info(`Webhook URL: http://localhost:${port}/api/github/webhooks`);
	logger.info(`Health check: http://localhost:${port}/health`);
}

// Run
main().catch((error) => {
	logger.fatal({ error }, "Failed to start Elapse");
	process.exit(1);
});

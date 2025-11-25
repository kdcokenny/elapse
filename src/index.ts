/**
 * Elapse - AI-powered standup bot
 * Entry point that wires everything together.
 */

import { Queue } from "bullmq";
import { Probot, Server } from "probot";
import { logger } from "./logger";
import { redis } from "./redis";
import { createReportWorker, setupReportScheduler } from "./reporter";
import { createSetupServer } from "./setup";
import { initShutdownHandlers, registerShutdownHandler } from "./shutdown";
import { createWebhookApp } from "./webhook";
import { createWorker, QUEUE_NAME } from "./worker";

interface Credentials {
	appId: string;
	privateKey: string;
	webhookSecret: string;
}

/**
 * Get credentials from environment variables.
 */
function getCredentials(): Credentials | null {
	if (process.env.APP_ID && process.env.PRIVATE_KEY) {
		return {
			appId: process.env.APP_ID,
			privateKey: process.env.PRIVATE_KEY,
			webhookSecret: process.env.WEBHOOK_SECRET || "",
		};
	}
	return null;
}

/**
 * Start in setup mode - show GitHub App registration UI.
 */
function startSetupMode(port: number) {
	logger.info("No credentials found, entering setup mode...");

	const server = createSetupServer(port);

	// Register shutdown handler for the setup server
	registerShutdownHandler(async () => {
		logger.info("Stopping setup server...");
		server.close();
		logger.info("Setup server stopped");
	});

	// Register Redis shutdown
	registerShutdownHandler(async () => {
		logger.info("Closing Redis connection...");
		await redis.quit();
		logger.info("Redis connection closed");
	});

	server.listen(port, "0.0.0.0", () => {
		logger.info({ port }, "Elapse is in SETUP MODE");
		logger.info(`Visit http://localhost:${port} to configure GitHub App`);
		logger.info("After setup, copy credentials to env vars and redeploy");
	});
}

/**
 * Start in normal mode - process webhooks and generate reports.
 */
async function startNormalMode(credentials: Credentials, port: number) {
	logger.info("Credentials found, starting in normal mode...");

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
			appId: credentials.appId,
			privateKey: credentials.privateKey,
			secret: credentials.webhookSecret,
		}),
		port,
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

	logger.info({ port }, "Elapse is running");
	logger.info(`Webhook URL: http://localhost:${port}/api/github/webhooks`);
	logger.info(`Health check: http://localhost:${port}/health`);
}

async function main() {
	logger.info("Starting Elapse...");

	// Initialize shutdown handlers
	initShutdownHandlers();

	const port = parseInt(process.env.PORT || "3000", 10);

	// Get credentials from environment variables
	const credentials = getCredentials();

	if (!credentials) {
		// No credentials - enter setup mode
		startSetupMode(port);
	} else {
		// Credentials available - normal operation
		await startNormalMode(credentials, port);
	}
}

// Run
main().catch((error) => {
	logger.fatal({ error }, "Failed to start Elapse");
	process.exit(1);
});

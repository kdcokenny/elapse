/**
 * Elapse - AI-powered standup bot
 * Entry point that wires everything together.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { Queue } from "bullmq";
import { createNodeMiddleware, createProbot } from "probot";
import { type Credentials, getCredentials } from "./credentials";
import { logger } from "./logger";
import { redis } from "./redis";
import { createReportWorker, setupReportScheduler } from "./reporter";
import { createSetupServer } from "./setup";
import { initShutdownHandlers, registerShutdownHandler } from "./shutdown";
import { createWebhookApp } from "./webhook";
import { createWorker, QUEUE_NAME } from "./worker";

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

	// Create Probot instance
	const probot = createProbot({
		overrides: {
			appId: credentials.appId,
			privateKey: credentials.privateKey,
			secret: credentials.webhookSecret,
		},
	});

	// Create webhook middleware
	const webhookMiddleware = await createNodeMiddleware(
		createWebhookApp(queue),
		{
			probot,
			webhooksPath: "/api/github/webhooks",
		},
	);

	// Create HTTP server with custom routes
	const server: HttpServer = createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://localhost:${port}`);

		// Health endpoint
		if (url.pathname === "/health" && req.method === "GET") {
			const redisOk = redis.status === "ready";
			const status = redisOk ? "healthy" : "unhealthy";
			const statusCode = status === "healthy" ? 200 : 503;
			res.writeHead(statusCode, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					status,
					redis: redisOk ? "up" : "down",
					timestamp: new Date().toISOString(),
				}),
			);
			return;
		}

		// Probot webhook handler
		if (
			url.pathname === "/api/github/webhooks" &&
			(req.method === "POST" || req.method === "GET")
		) {
			await webhookMiddleware(req, res);
			return;
		}

		// 404 for all other routes
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not Found" }));
	});

	// Register server shutdown
	registerShutdownHandler(async () => {
		logger.info("Stopping HTTP server...");
		await new Promise<void>((resolve) => server.close(() => resolve()));
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
	server.listen(port, () => {
		logger.info({ port }, "Elapse is running");
		logger.info(`Webhook URL: http://localhost:${port}/api/github/webhooks`);
		logger.info(`Health check: http://localhost:${port}/health`);
	});
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

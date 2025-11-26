/**
 * Graceful shutdown handler.
 * Ensures all components are properly closed before exit.
 */

import { logger } from "./logger";

type ShutdownHandler = () => Promise<void>;

const handlers: ShutdownHandler[] = [];
let isShuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Register a shutdown handler.
 * Handlers are called in reverse order (LIFO).
 */
export function registerShutdownHandler(handler: ShutdownHandler): void {
	handlers.push(handler);
}

/**
 * Execute graceful shutdown.
 */
async function shutdown(signal: string): Promise<void> {
	if (isShuttingDown) {
		logger.warn("Shutdown already in progress, forcing exit");
		process.exit(1);
	}

	isShuttingDown = true;
	logger.info({ signal }, "Graceful shutdown initiated");

	// Set hard timeout
	const forceExitTimeout = setTimeout(() => {
		logger.error("Graceful shutdown timed out, forcing exit");
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS);

	try {
		// Run handlers in reverse order (last registered first)
		for (let i = handlers.length - 1; i >= 0; i--) {
			const handler = handlers[i];
			if (!handler) continue;
			try {
				await handler();
			} catch (error) {
				logger.error(
					{ err: error, handlerIndex: i },
					"Shutdown handler failed",
				);
			}
		}

		clearTimeout(forceExitTimeout);
		logger.info("Graceful shutdown complete");
		process.exit(0);
	} catch (error) {
		logger.error({ err: error }, "Error during shutdown");
		process.exit(1);
	}
}

/**
 * Initialize shutdown signal handlers.
 */
export function initShutdownHandlers(): void {
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	// Handle uncaught errors
	process.on("uncaughtException", (error) => {
		logger.fatal({ err: error }, "Uncaught exception");
		shutdown("uncaughtException");
	});

	process.on("unhandledRejection", (reason, _promise) => {
		logger.error({ reason }, "Unhandled rejection");
		// Don't shutdown for unhandled rejections, just log
	});

	logger.debug("Shutdown handlers initialized");
}

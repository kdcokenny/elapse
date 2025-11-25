import pino from "pino";

const isDevelopment = process.env.NODE_ENV !== "production";

export const logger = pino({
	level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),

	// Pretty print in development
	transport: isDevelopment
		? {
				target: "pino-pretty",
				options: { colorize: true },
			}
		: undefined,

	// Base context for all logs
	base: {
		service: "elapse",
	},

	// Redact sensitive fields
	redact: {
		paths: [
			"req.headers.authorization",
			"github.token",
			"*.privateKey",
			"*.PRIVATE_KEY",
		],
		censor: "[REDACTED]",
	},
});

// Child loggers for different components
export const webhookLogger = logger.child({ component: "webhook" });
export const workerLogger = logger.child({ component: "worker" });
export const reportLogger = logger.child({ component: "report" });
export const aiLogger = logger.child({ component: "ai" });

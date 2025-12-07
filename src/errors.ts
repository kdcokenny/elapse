/**
 * Base error class for Elapse application errors.
 */
export class ElapseError extends Error {
	constructor(
		message: string,
		public override readonly cause?: Error,
	) {
		super(message);
		this.name = this.constructor.name;
	}
}

/**
 * Retryable errors - BullMQ will retry these with backoff.
 */
export class RetryableError extends ElapseError {
	constructor(
		message: string,
		public readonly retryAfterMs?: number,
		cause?: Error,
	) {
		super(message, cause);
	}
}

/**
 * Non-retryable errors - fail immediately, don't retry.
 */
export class NonRetryableError extends ElapseError {}

// Specific error types

export class GitHubAPIError extends RetryableError {}

export class AIProviderError extends RetryableError {}

export class AIProviderTimeoutError extends AIProviderError {
	constructor(timeoutMs: number, cause?: Error) {
		super(`AI request timed out after ${timeoutMs}ms`, undefined, cause);
	}
}

export class DiscordWebhookError extends RetryableError {}

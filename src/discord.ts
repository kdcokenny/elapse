/**
 * Discord webhook utilities.
 */

import { DISCORD_TIMEOUT_MS } from "./config";
import { DiscordWebhookError } from "./errors";
import { reportLogger } from "./logger";

/**
 * Report type for webhook URL lookup.
 * - "daily": DISCORD_WEBHOOK_URL_DAILY → DISCORD_WEBHOOK_URL
 * - "weekly": DISCORD_WEBHOOK_URL_WEEKLY → DISCORD_WEBHOOK_URL
 */
export type ReportType = "daily" | "weekly";

// =============================================================================
// Discord Embed Types
// =============================================================================

/**
 * Discord embed field structure.
 */
export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

/**
 * Discord embed footer structure.
 */
export interface DiscordEmbedFooter {
	text: string;
	icon_url?: string;
}

/**
 * Discord embed structure for webhook payloads.
 * @see https://discord.com/developers/docs/resources/message#embed-object
 */
export interface DiscordEmbed {
	title?: string;
	description?: string;
	color?: number;
	fields?: DiscordEmbedField[];
	footer?: DiscordEmbedFooter;
	timestamp?: string;
}

/**
 * Discord webhook response when using ?wait=true.
 * Contains message ID needed for thread posting.
 */
export interface DiscordWebhookResponse {
	id: string;
	channel_id: string;
}

/**
 * RAG status colors for embed sidebar.
 * These are decimal values for Discord's color field.
 */
export const RAG_COLORS = {
	green: 0x2ecc71, // Green - On Track
	yellow: 0xf1c40f, // Yellow - At Risk
	red: 0xe74c3c, // Red - Blocked
} as const;

/**
 * Thread auto-archive durations in minutes.
 */
export const THREAD_ARCHIVE_DURATION = {
	daily: 1440, // 24 hours
	weekly: 10080, // 7 days
} as const;

/**
 * Maximum message length for thread content.
 * Discord's limit is 2000, but we leave a buffer for edge cases.
 */
const MAX_THREAD_MESSAGE_LENGTH = 1900;

/**
 * Delay between posting thread chunks to maintain message order.
 */
const CHUNK_POST_DELAY_MS = 100;

/**
 * Split content into chunks that fit within Discord's message limit.
 * Splits on newline boundaries to preserve formatting.
 *
 * @param content - The content to split
 * @param maxLength - Maximum length per chunk (default: MAX_THREAD_MESSAGE_LENGTH)
 * @returns Array of content chunks
 */
export function splitIntoChunks(
	content: string,
	maxLength: number = MAX_THREAD_MESSAGE_LENGTH,
): string[] {
	if (!content || content.length === 0) {
		return [];
	}

	// Trim content and check if it's empty after trimming
	const trimmedContent = content.trim();
	if (trimmedContent.length === 0) {
		return [];
	}

	if (trimmedContent.length <= maxLength) {
		return [trimmedContent];
	}

	const chunks: string[] = [];
	const lines = trimmedContent.split("\n");
	let currentChunk = "";

	for (const line of lines) {
		// If adding this line would exceed the limit
		if (currentChunk.length + line.length + 1 > maxLength) {
			// Save current chunk if it has content
			const trimmed = currentChunk.trim();
			if (trimmed) {
				chunks.push(trimmed);
			}
			// Start new chunk with this line
			currentChunk = line;
		} else {
			// Add line to current chunk
			currentChunk += (currentChunk ? "\n" : "") + line;
		}
	}

	// Don't forget the last chunk
	const lastTrimmed = currentChunk.trim();
	if (lastTrimmed) {
		chunks.push(lastTrimmed);
	}

	return chunks;
}

/**
 * Send thread content as multiple messages if needed.
 * Posts chunks sequentially with a small delay to maintain order.
 *
 * @param webhookUrl - Discord webhook URL
 * @param threadId - Thread ID to post to
 * @param content - Content to post (will be chunked if needed)
 * @param log - Logger instance
 */
async function sendThreadContent(
	webhookUrl: string,
	threadId: string,
	content: string,
	log: typeof reportLogger,
): Promise<void> {
	const chunks = splitIntoChunks(content, MAX_THREAD_MESSAGE_LENGTH);

	if (chunks.length === 0) {
		log.warn({ threadId }, "No content to post to thread");
		return;
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i] as string; // Safe: loop bounds guarantee valid index

		try {
			const response = await fetch(`${webhookUrl}?thread_id=${threadId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: chunk }),
				signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
			});

			if (!response.ok) {
				log.warn(
					{
						chunkIndex: i,
						chunkLength: chunk.length,
						totalChunks: chunks.length,
						status: response.status,
						threadId,
					},
					"Failed to post thread chunk, continuing with remaining",
				);
			}
		} catch (err) {
			log.warn(
				{
					chunkIndex: i,
					chunkLength: chunk.length,
					totalChunks: chunks.length,
					error: err instanceof Error ? err.message : String(err),
					threadId,
				},
				"Failed to post thread chunk, continuing with remaining",
			);
		}

		// Small delay between chunks to maintain order (skip after last chunk)
		if (i < chunks.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, CHUNK_POST_DELAY_MS));
		}
	}
}

/**
 * Payload for hybrid Discord delivery.
 */
export interface HybridDiscordPayload {
	embed: DiscordEmbed;
	threadName: string;
	threadContent: string;
	type: ReportType;
}

/**
 * Get the webhook URL for a given report type.
 */
function getWebhookUrl(type: ReportType): string | undefined {
	const envKey =
		type === "daily"
			? "DISCORD_WEBHOOK_URL_DAILY"
			: "DISCORD_WEBHOOK_URL_WEEKLY";

	return process.env[envKey] || process.env.DISCORD_WEBHOOK_URL;
}

/**
 * Send a message to Discord webhook.
 * Looks up webhook URL based on report type, falling back to base URL.
 *
 * @deprecated Use sendHybridToDiscord() for new implementations.
 * This function will be removed in a future version.
 */
export async function sendToDiscord(
	content: string,
	type: ReportType,
): Promise<void> {
	const webhookUrl = getWebhookUrl(type);

	if (!webhookUrl) {
		reportLogger.warn(
			"Discord webhook URL not configured, logging report instead",
		);
		console.log(`\n${"=".repeat(60)}`);
		console.log(content);
		console.log(`${"=".repeat(60)}\n`);
		return;
	}

	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
		signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
	});

	if (!response.ok) {
		let retryAfterMs: number | undefined;

		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
		}

		throw new DiscordWebhookError(
			`Discord webhook failed: ${response.status} ${response.statusText}`,
			retryAfterMs,
		);
	}

	reportLogger.info({ type }, "Report sent to Discord");
}

/**
 * Send a hybrid message to Discord with embed in channel and details in thread.
 *
 * Two-phase delivery:
 * 1. POST embed with thread_name to create thread and get message ID
 * 2. POST thread content to the created thread using thread_id
 *
 * Falls back to single message on thread creation failure.
 */
export async function sendHybridToDiscord(
	payload: HybridDiscordPayload,
): Promise<void> {
	const { embed, threadName, threadContent, type } = payload;
	const webhookUrl = getWebhookUrl(type);

	if (!webhookUrl) {
		reportLogger.warn(
			"Discord webhook URL not configured, logging report instead",
		);
		console.log(`\n${"=".repeat(60)}`);
		console.log("EMBED:", JSON.stringify(embed, null, 2));
		console.log(`${"=".repeat(60)}`);
		console.log("THREAD CONTENT:");
		console.log(threadContent);
		console.log(`${"=".repeat(60)}\n`);
		return;
	}

	const log = reportLogger.child({ type, threadName });

	// Step 1: Send embed with thread_name to create thread
	// Use ?wait=true to get the message ID back
	const archiveDuration =
		type === "weekly"
			? THREAD_ARCHIVE_DURATION.weekly
			: THREAD_ARCHIVE_DURATION.daily;

	const createResponse = await fetch(`${webhookUrl}?wait=true`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			embeds: [embed],
			thread_name: threadName,
			auto_archive_duration: archiveDuration,
		}),
		signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
	});

	if (!createResponse.ok) {
		// Handle rate limiting
		if (createResponse.status === 429) {
			const retryAfter = createResponse.headers.get("Retry-After");
			const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
			throw new DiscordWebhookError(
				`Discord webhook rate limited: ${createResponse.status}`,
				retryAfterMs,
			);
		}

		// Fallback: try sending as single message without thread
		log.warn(
			{ status: createResponse.status },
			"Thread creation failed, falling back to single message",
		);
		await sendFallbackMessage(webhookUrl, embed, threadContent);
		return;
	}

	// Parse response to get message ID (which is also the thread ID)
	let messageData: DiscordWebhookResponse;
	try {
		messageData = (await createResponse.json()) as DiscordWebhookResponse;
	} catch {
		log.warn("Failed to parse webhook response, skipping thread content");
		return;
	}

	const threadId = messageData.id;
	log.debug({ threadId }, "Thread created, posting details");

	// Step 2: Send thread content to the created thread (chunked if needed)
	await sendThreadContent(webhookUrl, threadId, threadContent, log);

	log.info({ threadId }, "Hybrid report sent to Discord");
}

/**
 * Fallback: send embed and content as a single message when thread creation fails.
 * Truncates if content is too long.
 */
async function sendFallbackMessage(
	webhookUrl: string,
	embed: DiscordEmbed,
	threadContent: string,
): Promise<void> {
	// Discord message limit is 2000 chars
	const MAX_CONTENT_LENGTH = 1900; // Leave room for truncation indicator

	let content = threadContent;
	if (content.length > MAX_CONTENT_LENGTH) {
		content = `${content.slice(0, MAX_CONTENT_LENGTH)}...\n\n⚠️ *Report truncated due to length*`;
	}

	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content,
			embeds: [embed],
		}),
		signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new DiscordWebhookError(
			`Discord webhook fallback failed: ${response.status} ${response.statusText}`,
		);
	}

	reportLogger.info("Fallback report sent to Discord (no thread)");
}

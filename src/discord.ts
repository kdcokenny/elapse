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

/**
 * Send a message to Discord webhook.
 * Looks up webhook URL based on report type, falling back to base URL.
 */
export async function sendToDiscord(
	content: string,
	type: ReportType,
): Promise<void> {
	const envKey =
		type === "daily"
			? "DISCORD_WEBHOOK_URL_DAILY"
			: "DISCORD_WEBHOOK_URL_WEEKLY";

	const webhookUrl = process.env[envKey] || process.env.DISCORD_WEBHOOK_URL;

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

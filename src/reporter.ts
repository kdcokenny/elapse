/**
 * Daily report generator.
 * Uses BullMQ repeatable jobs to schedule and generate reports.
 */

import { type Job, type Queue, Worker } from "bullmq";
import { narrateDay } from "./ai";
import {
	formatDailyReport,
	getTodayDate,
	type UserSummary,
} from "./core/formatting";
import { DiscordWebhookError } from "./errors";
import { reportLogger } from "./logger";
import { getAllTranslationsForDate, redis } from "./redis";

const QUEUE_NAME = "elapse";
const DISCORD_TIMEOUT_MS = 10000;

interface ReportJob {
	type: "daily";
	date?: string; // Optional override, defaults to today
}

/**
 * Send a message to Discord webhook.
 */
async function sendToDiscord(content: string): Promise<void> {
	const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

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

	reportLogger.info("Report sent to Discord");
}

/**
 * Generate the daily report content.
 */
async function generateReport(date: string): Promise<string | null> {
	const log = reportLogger.child({ date });

	log.info("Generating daily report");

	// Get all translations for the date
	const translationsByUser = await getAllTranslationsForDate(date);

	if (translationsByUser.size === 0) {
		log.info("No translations found for date");
		return null;
	}

	log.debug({ userCount: translationsByUser.size }, "Found translations");

	// Generate narrative for each user
	const userSummaries: UserSummary[] = [];

	for (const [user, translations] of translationsByUser) {
		// Filter out SKIPs
		const meaningful = translations.filter((t) => t !== "SKIP");

		if (meaningful.length === 0) {
			log.debug({ user }, "No meaningful translations for user");
			continue;
		}

		const narrative = await narrateDay(meaningful, date);

		userSummaries.push({
			user,
			narrative,
			commitCount: meaningful.length,
		});

		log.debug(
			{ user, commitCount: meaningful.length },
			"Generated user summary",
		);
	}

	if (userSummaries.length === 0) {
		log.info("No meaningful summaries to report");
		return null;
	}

	// Format the report
	const report = formatDailyReport(date, userSummaries);

	log.info(
		{
			userCount: userSummaries.length,
			totalCommits: userSummaries.reduce((sum, s) => sum + s.commitCount, 0),
		},
		"Report generated",
	);

	return report;
}

/**
 * Process a report job.
 */
async function processReportJob(
	job: Job<ReportJob>,
): Promise<{ sent: boolean }> {
	const date = job.data.date || getTodayDate();
	const log = reportLogger.child({ jobId: job.id, date });

	log.info("Processing report job");

	try {
		const content = await generateReport(date);

		if (!content) {
			log.info("No content to report");
			return { sent: false };
		}

		await sendToDiscord(content);

		return { sent: true };
	} catch (error) {
		log.error({ err: error }, "Report job failed");
		throw error;
	}
}

/**
 * Set up the daily report scheduler using BullMQ repeatable jobs.
 */
export async function setupReportScheduler(queue: Queue): Promise<void> {
	const timezone = process.env.TEAM_TIMEZONE || "America/New_York";
	const schedule = process.env.SCHEDULE || "0 9 * * 1-5"; // 9 AM Mon-Fri

	await queue.upsertJobScheduler(
		"daily-report",
		{
			pattern: schedule,
			tz: timezone,
		},
		{
			name: "report",
			data: { type: "daily" },
			opts: {
				attempts: 3,
				backoff: {
					type: "fixed",
					delay: 300000, // 5 minutes between retries
				},
			},
		},
	);

	reportLogger.info(
		{ schedule, timezone },
		"Daily report scheduler configured",
	);
}

/**
 * Create and start the report worker.
 */
export function createReportWorker(): Worker<ReportJob> {
	const worker = new Worker<ReportJob>(
		QUEUE_NAME,
		async (job) => {
			// Only handle report jobs
			if (job.name !== "report") {
				return;
			}
			return processReportJob(job);
		},
		{
			connection: redis,
			concurrency: 1, // Only one report at a time
		},
	);

	worker.on("completed", (job) => {
		if (job.name === "report") {
			reportLogger.info({ jobId: job.id }, "Report job completed");
		}
	});

	worker.on("failed", (job, error) => {
		if (job?.name === "report") {
			reportLogger.error({ jobId: job.id, err: error }, "Report job failed");
		}
	});

	reportLogger.info("Report worker started");

	return worker;
}

// Export for manual triggering
export { generateReport, sendToDiscord };

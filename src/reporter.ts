/**
 * Daily report generator.
 * Uses BullMQ repeatable jobs to schedule and generate reports.
 */

import { type Job, type Queue, Worker } from "bullmq";
import { narrateFeature } from "./ai";
import { type BlockerSummary, groupBlockersByUser } from "./core/blockers";
import {
	type ActivityStats,
	type BranchSummary,
	type FeatureSummary,
	formatFeatureCentricReport,
	formatNoActivityReport,
	getTodayDate,
} from "./core/formatting";
import { DiscordWebhookError } from "./errors";
import { reportLogger } from "./logger";
import { getAllPRDataForDate, redis } from "./redis";

const QUEUE_NAME = "elapse";
const DISCORD_TIMEOUT_MS = 10000;

// Enable in-progress section via env
const SHOW_IN_PROGRESS = process.env.SHOW_IN_PROGRESS !== "false";

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
	const log = reportLogger.child({ date, mode: "pr-centric" });

	log.info("Generating PR-centric daily report");

	const data = await getAllPRDataForDate(date);

	const hasMerged = data.mergedPRs.size > 0;
	const hasOpen = data.openPRs.size > 0;
	const hasDirect = data.directCommits.length > 0;

	// Check for blockers across open PRs
	let totalBlockers = 0;
	for (const pr of data.openPRs.values()) {
		totalBlockers += pr.blockers.size;
	}

	if (!hasMerged && !hasOpen && !hasDirect && totalBlockers === 0) {
		log.info("No PR activity to report for date");
		return null; // Will fall back to legacy or show no activity
	}

	log.debug(
		{
			mergedPRs: data.mergedPRs.size,
			openPRs: data.openPRs.size,
			directCommits: data.directCommits.length,
			totalBlockers,
		},
		"Found PR-centric data for report",
	);

	// Generate SHIPPED section from merged PRs
	const featureSummaries: FeatureSummary[] = [];
	for (const [prNumber, pr] of data.mergedPRs) {
		const texts = pr.translations.map((t) => t.summary);

		// Use AI to generate feature name and impact
		const { featureName, impact } = await narrateFeature(
			pr.meta.title,
			prNumber,
			texts,
		);

		featureSummaries.push({
			featureName,
			impact,
			prNumber,
			authors: pr.meta.authors,
			commitCount: pr.translations.length,
		});
	}

	// Generate IN PROGRESS section from open PRs (with AI translation)
	const progressSummaries: BranchSummary[] = [];
	if (SHOW_IN_PROGRESS) {
		// Collect all narration promises for parallel execution
		const progressPromises = Array.from(data.openPRs.entries()).map(
			async ([prNumber, pr]) => {
				const texts = pr.translations.map((t) => t.summary);

				// Use AI to generate feature name and impact
				const { featureName, impact } = await narrateFeature(
					pr.meta.title,
					prNumber,
					texts,
				);

				return {
					branch: pr.meta.branch,
					users: pr.meta.authors,
					commitCount: pr.translations.length,
					prTitle: pr.meta.title,
					prNumber,
					hasActivityToday: pr.hasActivityToday,
					featureName,
					impact,
				};
			},
		);

		const results = await Promise.all(progressPromises);
		progressSummaries.push(...results);
	}

	// Generate BLOCKERS section from open PRs
	const blockersSummary: BlockerSummary[] = [];
	for (const [prNumber, pr] of data.openPRs) {
		for (const blocker of pr.blockers.values()) {
			if (!blocker.resolvedAt) {
				blockersSummary.push({
					branch: pr.meta.branch,
					description: blocker.description,
					user: pr.meta.authors[0] ?? "unknown",
					prNumber,
					prTitle: pr.meta.title,
				});
			}
		}
	}

	// Calculate stats
	const stats: ActivityStats = {
		prsMerged: featureSummaries.length,
		branchesActive: progressSummaries.length,
		totalCommits:
			featureSummaries.reduce((sum, f) => sum + f.commitCount, 0) +
			progressSummaries.reduce((sum, p) => sum + p.commitCount, 0) +
			data.directCommits.length,
		blockerCount: blockersSummary.length,
	};

	// No meaningful activity
	if (
		featureSummaries.length === 0 &&
		progressSummaries.length === 0 &&
		blockersSummary.length === 0
	) {
		log.info("No activity to report for date");
		return formatNoActivityReport(date);
	}

	// Group blockers by user for consolidated display
	const blockerGroups = groupBlockersByUser(blockersSummary);

	const report = formatFeatureCentricReport(
		date,
		blockerGroups,
		featureSummaries,
		progressSummaries,
		stats,
	);

	log.info(
		{
			featuresShipped: featureSummaries.length,
			progressCount: progressSummaries.length,
			blockerCount: blockersSummary.length,
		},
		"PR-centric report generated",
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

// Export for manual triggering and testing
export { generateReport, sendToDiscord };

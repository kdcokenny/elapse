/**
 * Daily report generator.
 * Uses BullMQ repeatable jobs to schedule and generate reports.
 */

import type { Job, Queue } from "bullmq";
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
import { getWatermark } from "./core/watermark";
import { DiscordWebhookError } from "./errors";
import { reportLogger } from "./logger";
import {
	getAllPRDataForDate,
	getLastReportTimestamp,
	setLastReportTimestamp,
} from "./redis";

const DISCORD_TIMEOUT_MS = 10000;

// Enable in-progress section via env
const SHOW_IN_PROGRESS = process.env.SHOW_IN_PROGRESS !== "false";

export interface ReportJob {
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
 * Returns both the report content and the watermark timestamp for idempotent updates.
 */
async function generateReport(
	date: string,
	sinceTimestamp?: string,
): Promise<{ content: string | null; watermark: string }> {
	const log = reportLogger.child({
		date,
		mode: "pr-centric",
		sinceTimestamp: sinceTimestamp ?? "none",
	});

	log.info("Generating PR-centric daily report");

	const data = await getAllPRDataForDate(date, sinceTimestamp);

	// Calculate watermark from data (before any early returns)
	const watermark = getWatermark(data);

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
		return { content: formatNoActivityReport(date), watermark };
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
			repo: pr.meta.repo,
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
					repo: pr.meta.repo,
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
					repo: pr.meta.repo,
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
		return { content: formatNoActivityReport(date), watermark };
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
			watermark,
		},
		"PR-centric report generated",
	);

	return { content: report, watermark };
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
		// Get last report timestamp (null = first run, defaults to today)
		const lastReportTimestamp = await getLastReportTimestamp();
		const sinceTimestamp = lastReportTimestamp ?? `${date}T00:00:00.000Z`;

		log.info(
			{ sinceTimestamp, isFirstRun: !lastReportTimestamp },
			"Generating report since timestamp",
		);

		const { content, watermark } = await generateReport(date, sinceTimestamp);

		if (!content) {
			log.info("No content to report");
			// Still update watermark on no-content to avoid re-querying same window
			await setLastReportTimestamp(watermark);
			return { sent: false };
		}

		await sendToDiscord(content);

		// Store watermark after successful send (idempotent - same data = same watermark)
		await setLastReportTimestamp(watermark);
		log.info({ watermark }, "Report watermark updated");

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

// Export for testing and worker integration
export { generateReport, processReportJob };

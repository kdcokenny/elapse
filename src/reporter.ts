/**
 * Daily report generator.
 * Uses BullMQ repeatable jobs to schedule and generate reports.
 */

import { type Job, type Queue, Worker } from "bullmq";
import { narrateFeature } from "./ai";
import { generateBlockersSummary } from "./core/blockers";
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
import { getAllForDate, redis, type StoredTranslation } from "./redis";

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
 * Group translations by PR number for feature-centric reporting.
 */
interface PRGroup {
	prNumber: number;
	prTitle: string;
	translations: StoredTranslation[];
	authors: Set<string>;
}

/**
 * Generate shipped section with feature-centric format.
 * Groups by PR (one PR = one feature), skips commits without PRs.
 */
async function generateFeatureShippedSection(
	shipped: Map<string, StoredTranslation[]>,
	_date: string,
): Promise<FeatureSummary[]> {
	// Group all translations by PR number
	const byPR = new Map<number, PRGroup>();

	for (const [user, translations] of shipped) {
		for (const t of translations) {
			// Skip non-PR commits and empty summaries
			if (!t.summary || !t.prNumber) {
				continue;
			}

			let prData = byPR.get(t.prNumber);
			if (!prData) {
				prData = {
					prNumber: t.prNumber,
					prTitle: t.prTitle || `PR #${t.prNumber}`,
					translations: [],
					authors: new Set(),
				};
				byPR.set(t.prNumber, prData);
			}

			prData.translations.push(t);
			prData.authors.add(user);

			// Update title if we have a better one
			if (t.prTitle && prData.prTitle === `PR #${t.prNumber}`) {
				prData.prTitle = t.prTitle;
			}
		}
	}

	// Generate feature summaries for each PR
	const summaries: FeatureSummary[] = [];

	for (const [prNumber, prData] of byPR) {
		const texts = prData.translations.map((t) => t.summary);

		// Use AI to generate feature name and impact
		const { featureName, impact } = await narrateFeature(
			prData.prTitle,
			prNumber,
			texts,
		);

		summaries.push({
			featureName,
			impact,
			prNumber,
			authors: Array.from(prData.authors),
			commitCount: prData.translations.length,
		});
	}

	return summaries;
}

/**
 * Generate progress section with brief bullets by branch.
 * No AI - just structured data.
 */
function generateProgressSection(
	progress: Map<string, StoredTranslation[]>,
): BranchSummary[] {
	// Group by branch across all users, capturing PR metadata
	const byBranch = new Map<
		string,
		{
			users: Set<string>;
			count: number;
			prTitle?: string;
			prNumber?: number;
		}
	>();

	for (const [user, translations] of progress) {
		for (const t of translations) {
			if (!t.summary) continue;

			if (!byBranch.has(t.branch)) {
				byBranch.set(t.branch, {
					users: new Set(),
					count: 0,
					prTitle: t.prTitle,
					prNumber: t.prNumber,
				});
			}
			const branchData = byBranch.get(t.branch);
			if (branchData) {
				branchData.users.add(user);
				branchData.count++;
				// Update PR metadata if not already set (first translation wins)
				if (!branchData.prTitle && t.prTitle) {
					branchData.prTitle = t.prTitle;
				}
				if (!branchData.prNumber && t.prNumber) {
					branchData.prNumber = t.prNumber;
				}
			}
		}
	}

	// Return brief bullets with PR context (NO AI narration for progress)
	return Array.from(byBranch.entries()).map(([branch, data]) => ({
		branch,
		users: Array.from(data.users),
		commitCount: data.count,
		prTitle: data.prTitle,
		prNumber: data.prNumber,
	}));
}

/**
 * Generate the daily report content with sections.
 */
async function generateReport(date: string): Promise<string | null> {
	const log = reportLogger.child({ date });

	log.info("Generating daily report");

	// Get all data for the date
	const data = await getAllForDate(date);

	const hasShipped = data.shipped.size > 0;
	const hasProgress = data.progress.size > 0;
	const hasBlockers = data.blockers.length > 0;

	if (!hasShipped && !hasProgress && !hasBlockers) {
		log.info("No activity to report for date");
		return formatNoActivityReport(date);
	}

	log.debug(
		{
			shippedUsers: data.shipped.size,
			progressUsers: data.progress.size,
			blockers: data.blockers.length,
		},
		"Found data for report",
	);

	// Generate blockers section
	const blockersSummary = generateBlockersSummary(data.blockers);

	// Generate shipped section with feature-centric format (one PR = one feature)
	const featureSummaries = await generateFeatureShippedSection(
		data.shipped,
		date,
	);

	// Generate progress section (no AI)
	const progressSummaries = SHOW_IN_PROGRESS
		? generateProgressSection(data.progress)
		: [];

	// Calculate stats - prsMerged is now based on feature summaries
	const stats: ActivityStats = {
		prsMerged: featureSummaries.length,
		branchesActive: progressSummaries.length,
		totalCommits:
			featureSummaries.reduce((sum, f) => sum + f.commitCount, 0) +
			progressSummaries.reduce((sum, p) => sum + p.commitCount, 0),
		blockerCount: blockersSummary.length,
	};

	// Check if we have anything meaningful to report
	if (
		featureSummaries.length === 0 &&
		progressSummaries.length === 0 &&
		blockersSummary.length === 0
	) {
		log.info("No meaningful content to report");
		return formatNoActivityReport(date);
	}

	// Format the report with feature-centric format
	const report = formatFeatureCentricReport(
		date,
		blockersSummary,
		featureSummaries,
		progressSummaries,
		stats,
	);

	log.info(
		{
			featuresShipped: featureSummaries.length,
			progressCount: progressSummaries.length,
			blockerCount: blockersSummary.length,
			prsMerged: stats.prsMerged,
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

// Export for manual triggering and testing
export {
	generateReport,
	sendToDiscord,
	// Export helpers for E2E testing with production code paths
	generateFeatureShippedSection,
	generateProgressSection,
};

/**
 * Weekly report generator.
 * Aggregates Mon-Fri activity into a stakeholder-ready summary.
 */

import type { Job, Queue } from "bullmq";
import { generateWeeklySummary } from "./ai";
import {
	DEFAULT_REPORT_CADENCE,
	DEFAULT_WEEKLY_SCHEDULE,
	getTimezone,
} from "./config";
import { detectStaleReviews } from "./core/blockers";
import {
	formatWeeklyMainEmbed,
	formatWeeklyThreadContent,
	getThreadName,
	type WeeklyDataFlags,
	type WeeklyHybridData,
} from "./core/formatting";
import { calculateBlockerAgeDays, getWeekBoundary } from "./core/weekly-data";
import { determineRAGStatus } from "./core/weekly-status";
import type { WeeklyStats } from "./core/weekly-types";
import { sendHybridToDiscord } from "./discord";
import { reportLogger } from "./logger";
import { getWeeklyPRData, setLastWeeklyReportTimestamp } from "./redis";

export interface WeeklyReportJob {
	type: "weekly";
	weekOf?: string; // Optional override: "2025-02-24"
}

/**
 * Generate the weekly report data.
 */
export async function generateWeeklyReport(reportDate?: Date): Promise<{
	data: WeeklyHybridData | null;
	watermark: string;
}> {
	const now = reportDate || new Date();
	const timezone = getTimezone();
	const log = reportLogger.child({ operation: "weekly-report" });

	log.info({ reportDate: now.toISOString() }, "Generating weekly report");

	// Calculate week boundary
	const weekBoundary = getWeekBoundary(now, timezone);
	const weekStart = weekBoundary.start.toISOString();
	const weekEnd = weekBoundary.end.toISOString();

	log.debug(
		{ weekStart, weekEnd, dates: weekBoundary.dateStrings },
		"Week boundary calculated",
	);

	// Fetch all data for the week
	const { mergedPRs, openPRs, activeBlockers, resolvedBlockers } =
		await getWeeklyPRData(weekStart, weekEnd, weekBoundary.dateStrings);

	// Detect stale reviews (pending_review blockers >= 3 days old)
	const staleReviews = detectStaleReviews(openPRs);

	// Calculate watermark (latest activity timestamp)
	let latestTimestamp = weekEnd;
	for (const pr of mergedPRs.values()) {
		if (pr.meta.mergedAt && pr.meta.mergedAt > latestTimestamp) {
			latestTimestamp = pr.meta.mergedAt;
		}
	}

	// Check for empty week
	if (
		mergedPRs.size === 0 &&
		activeBlockers.length === 0 &&
		openPRs.size === 0
	) {
		log.info("No activity for week, generating empty report");
		return {
			data: null,
			watermark: latestTimestamp,
		};
	}

	// Build data for AI
	const shippedData = Array.from(mergedPRs.values()).map((pr) => ({
		translation: pr.translations[0]?.summary || pr.meta.title,
		author: pr.meta.authors[0] || "unknown",
	}));

	const blockerData = activeBlockers.map((b) => ({
		reason: b.blocker.description,
		ageDays: calculateBlockerAgeDays(b.blocker.detectedAt, now),
		author: b.meta.authors[0] || "unknown",
		mentionedUsers: b.blocker.mentionedUsers || [],
	}));

	const resolvedData = resolvedBlockers.map((b) => ({
		reason: b.blocker.description,
	}));

	const progressData = Array.from(openPRs.values()).map((pr) => ({
		translation: pr.translations[0]?.summary || pr.meta.title,
		author: pr.meta.authors[0] || "unknown",
	}));

	// Compute data flags - only Next Week is conditional (content section)
	// Blockers and Help Needed are status sections - always shown
	const dataFlags: WeeklyDataFlags = {
		hasInProgress: progressData.length > 0,
	};

	// Generate AI summary
	// - Status sections (Blockers, Help Needed) always requested
	// - Content sections (Next Week) only if we have in-progress data
	log.debug(
		{
			shippedCount: shippedData.length,
			blockerCount: blockerData.length,
			hasInProgress: dataFlags.hasInProgress,
		},
		"Generating AI summary",
	);
	const summary = await generateWeeklySummary(
		shippedData,
		blockerData,
		resolvedData,
		progressData,
		{
			includeNextWeek: dataFlags.hasInProgress,
		},
	);

	// Determine RAG status (stale reviews affect yellow threshold)
	const ragStatus = determineRAGStatus({
		activeBlockers: blockerData,
		staleReviews: staleReviews.map((sr) => ({ daysWaiting: sr.daysAgo })),
	});

	// Build stats
	const contributors = new Set<string>();
	for (const pr of mergedPRs.values()) {
		for (const a of pr.meta.authors) {
			contributors.add(a);
		}
	}
	for (const pr of openPRs.values()) {
		for (const a of pr.meta.authors) {
			contributors.add(a);
		}
	}

	const stats: WeeklyStats = {
		totalMerged: mergedPRs.size,
		blockersResolved: resolvedBlockers.length,
		activeBlockerCount: activeBlockers.length,
		staleReviewCount: staleReviews.length,
		inProgressCount: openPRs.size,
		contributorCount: contributors.size,
	};

	// Build hybrid data with active blockers for escalation detection
	const hybridData: WeeklyHybridData = {
		weekOf: weekBoundary.start,
		ragStatus,
		summary,
		stats,
		activeBlockers: blockerData.map((b) => ({
			description: b.reason,
			owner: b.author,
			ageDays: b.ageDays,
		})),
	};

	log.info(
		{
			ragStatus,
			mergedCount: mergedPRs.size,
			blockerCount: activeBlockers.length,
		},
		"Weekly report generated",
	);

	return { data: hybridData, watermark: latestTimestamp };
}

/**
 * Process a weekly report job.
 */
export async function processWeeklyReportJob(
	job: Job<WeeklyReportJob>,
): Promise<{ sent: boolean }> {
	const log = reportLogger.child({ jobId: job.id, type: "weekly" });

	log.info("Processing weekly report job");

	try {
		const reportDate = job.data.weekOf ? new Date(job.data.weekOf) : new Date();
		const { data, watermark } = await generateWeeklyReport(reportDate);

		if (!data) {
			log.info("No content to report");
			await setLastWeeklyReportTimestamp(watermark);
			return { sent: false };
		}

		// Format and send hybrid report (embed + thread)
		const embed = formatWeeklyMainEmbed(data);
		const threadContent = formatWeeklyThreadContent(data);
		const threadName = getThreadName("weekly", data.weekOf);

		await sendHybridToDiscord({
			embed,
			threadName,
			threadContent,
			type: "weekly",
		});
		await setLastWeeklyReportTimestamp(watermark);

		log.info({ watermark }, "Weekly report sent and watermark updated");
		return { sent: true };
	} catch (error) {
		log.error({ err: error }, "Weekly report job failed");
		throw error;
	}
}

/**
 * Set up the weekly report scheduler.
 */
export async function setupWeeklyReportScheduler(queue: Queue): Promise<void> {
	const cadence = process.env.REPORT_CADENCE || DEFAULT_REPORT_CADENCE;

	// Skip if cadence doesn't include weekly
	if (cadence !== "weekly" && cadence !== "both") {
		reportLogger.info({ cadence }, "Weekly reports disabled by REPORT_CADENCE");
		return;
	}

	const timezone = getTimezone();
	const schedule = process.env.WEEKLY_SCHEDULE || DEFAULT_WEEKLY_SCHEDULE;

	await queue.upsertJobScheduler(
		"weekly-report",
		{
			pattern: schedule,
			tz: timezone,
		},
		{
			name: "report",
			data: { type: "weekly" },
			opts: {
				attempts: 3,
				backoff: {
					type: "fixed",
					delay: 300000, // 5 minutes
				},
			},
		},
	);

	reportLogger.info(
		{ schedule, timezone },
		"Weekly report scheduler configured",
	);
}

#!/usr/bin/env bun
/**
 * Week-Long E2E Simulation with Real AI
 *
 * Uses timeline-based replay to process fixture data chronologically:
 * - PRs stay open until their actual merge day (shows IN PROGRESS)
 * - Comments are processed on their createdAt date (enables BLOCKERS)
 * - Merges happen at end of day (shows SHIPPED TODAY)
 *
 * Usage:
 *   bun tests/e2e/week-simulation.ts
 *
 * ============================================================================
 * EXPECTED REPORTS BY DAY (September 5-20, 2025)
 * ============================================================================
 *
 * Sep 6 (Sat):
 *   SHIPPED: PR #9947 - fix: pasting not working in firefox
 *   IN PROGRESS: none
 *   BLOCKERS: none
 *
 * Sep 10 (Wed):
 *   SHIPPED: PR #9959 - fix: normalize file on paste/drop
 *   IN PROGRESS: none
 *   BLOCKERS: none
 *
 * Sep 12 (Fri):
 *   SHIPPED: PR #9910 - feat: compact layout for tablets
 *   IN PROGRESS: PR #9946 (eraser fix - opened today, 4 comments)
 *   BLOCKERS: TBD from comment analysis
 *
 * Sep 13 (Sat) - no commit, but 2 comments on PR #9946:
 *   (No fixture for this day - comments processed with Sep 14)
 *
 * Sep 14 (Sun):
 *   SHIPPED: PR #9946 - fix: eraser can handle dots
 *   IN PROGRESS: none
 *   BLOCKERS: none (resolved)
 *
 * Sep 15 (Mon):
 *   SHIPPED: PR #9979 - fix: Use the right polygon enclosure test
 *   IN PROGRESS: none
 *   BLOCKERS: none
 *
 * Sep 17 (Wed):
 *   SHIPPED: PR #9991 - fix: align MQ breakpoints
 *   IN PROGRESS: none
 *   BLOCKERS: none
 *
 * Sep 19 (Fri):
 *   SHIPPED: PR #9998 - fix: Mobile arrow point drag broken
 *   IN PROGRESS: none
 *   BLOCKERS: none
 *
 * KEY TEST CASE: Sep 12-14 tests the IN PROGRESS flow:
 *   - Sep 12: PR #9946 opens (first human comment mtolmacs asking for testing)
 *   - Sep 12-13: Discussion about testing freedraw eraser (4+ comments)
 *   - Sep 14: PR #9946 merges after "works on all edge cases" confirmation
 * ============================================================================
 */

import { analyzeComment, translateDiff } from "../../src/ai";
import {
	addBranchCommit,
	createOrUpdatePR,
	getPRMetadata,
	recordPRMerged,
	setPRBlocker,
	setPRStatus,
} from "../../src/redis";
import { generateReport } from "../../src/reporter";
import { listAvailableDates } from "../fixtures/loader";
import { initTestRedis, resetTestRedis, restoreRedis } from "./test-redis";
import {
	buildTimeline,
	type CommentData,
	type CommitData,
	getEventsForDay,
	type PRMergeData,
	type PROpenData,
	printTimelineSummary,
	type TimelineEvent,
} from "./timeline";

const REPO = "excalidraw";
const FULL_REPO = "excalidraw/excalidraw";

// Day names for display
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getDayName(dateStr: string): string {
	const date = new Date(dateStr);
	return DAY_NAMES[date.getDay()] ?? "???";
}

async function processEvent(
	event: TimelineEvent,
	dateStr: string,
): Promise<void> {
	switch (event.type) {
		case "pr_open": {
			const data = event.data as PROpenData;
			await createOrUpdatePR(event.prNumber, {
				repo: data.repo,
				branch: data.branch,
				title: data.title,
				authors: [data.author],
				status: "open",
				openedAt: event.timestamp,
			});
			// No branch->PR index - read-time resolution handles association
			console.log(`    → Opened PR #${event.prNumber}: ${data.title}`);
			break;
		}

		case "commit": {
			const data = event.data as CommitData;
			const shortSha = data.sha.slice(0, 7);
			const firstLine = data.message.split("\n")[0];
			console.log(`    [${shortSha}] ${firstLine}`);

			// Get branch from PR metadata
			const prMeta = await getPRMetadata(event.prNumber);
			if (!prMeta) {
				console.log("      → Skipped (PR metadata not found)");
				break;
			}

			console.log("      → Translating with AI...");
			try {
				const translation = await translateDiff(data.message, data.diff);

				if (translation.action === "skip") {
					console.log("      → Skipped (trivial change)");
					break;
				}

				console.log(`      → ${translation.summary}`);
				console.log(
					`      → Category: ${translation.category}, Significance: ${translation.significance}`,
				);

				// Store by branch - PR association happens at read time
				await addBranchCommit(FULL_REPO, prMeta.branch, {
					sha: data.sha,
					summary: translation.summary ?? "",
					category: translation.category ?? null,
					significance: translation.significance ?? null,
					author: data.user,
					timestamp: event.timestamp,
				});
			} catch (error) {
				console.error(`      → AI Error: ${(error as Error).message}`);
			}
			break;
		}

		case "comment": {
			const data = event.data as CommentData;

			// Skip bot comments
			if (data.author.endsWith("[bot]")) {
				break;
			}

			console.log(`    💬 Comment from ${data.author}`);

			try {
				const prMeta = await getPRMetadata(event.prNumber);
				const result = await analyzeComment(data.body, {
					title: prMeta?.title ?? "",
					number: event.prNumber,
				});

				if (result.action === "add_blocker" && result.description) {
					await setPRBlocker(event.prNumber, `comment:${data.id}`, {
						type: "comment",
						description: result.description,
						commentId: data.id,
						detectedAt: event.timestamp,
					});
					console.log(`      🔴 Blocker detected: ${result.description}`);
				} else if (result.action === "resolve_blocker") {
					console.log("      ✅ Blocker resolved");
				} else {
					console.log("      → No blocker detected");
				}
			} catch (error) {
				console.error(
					`      → Comment analysis error: ${(error as Error).message}`,
				);
			}
			break;
		}

		case "pr_merge": {
			const data = event.data as PRMergeData;
			await setPRStatus(event.prNumber, "merged", data.mergedAt);
			await recordPRMerged(event.prNumber, dateStr);
			// No branch cleanup - handled by background job
			console.log(`    🚢 PR #${event.prNumber} merged: ${data.title}`);
			break;
		}
	}
}

async function main() {
	console.log("=".repeat(70));
	console.log("WEEK-LONG E2E SIMULATION WITH TIMELINE REPLAY");
	console.log("Repository: Excalidraw");
	console.log("=".repeat(70));
	console.log();

	// Initialize Redis mock
	initTestRedis();
	await resetTestRedis();

	// Get available dates sorted
	const dates = listAvailableDates(REPO).sort();
	console.log(`Found ${dates.length} days of data: ${dates.join(", ")}`);

	// Build timeline from all fixtures
	console.log("\nBuilding timeline from fixtures...");
	const timeline = buildTimeline(REPO, FULL_REPO, dates);
	printTimelineSummary(timeline);

	// Process each day
	for (const dateStr of dates) {
		const dayName = getDayName(dateStr);

		console.log();
		console.log("=".repeat(70));
		console.log(`DAY: ${dateStr} (${dayName})`);
		console.log("=".repeat(70));

		const dayEvents = getEventsForDay(timeline, dateStr);
		console.log(`\nEvents to process: ${dayEvents.length}`);

		// Process all events for this day
		for (const event of dayEvents) {
			await processEvent(event, dateStr);
		}

		// Generate daily report
		console.log(`\n${"-".repeat(70)}`);
		console.log("DAILY REPORT");
		console.log("-".repeat(70));

		try {
			const { content } = await generateReport(dateStr);
			if (content) {
				console.log(content);
			} else {
				console.log("(No report generated - no activity)");
			}
		} catch (error) {
			console.error(`Report generation failed: ${(error as Error).message}`);
		}

		console.log("-".repeat(70));
	}

	// Cleanup
	restoreRedis();

	console.log(`\n${"=".repeat(70)}`);
	console.log("SIMULATION COMPLETE");
	console.log("=".repeat(70));

	// Exit cleanly (ioredis-mock keeps event loop alive)
	process.exit(0);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});

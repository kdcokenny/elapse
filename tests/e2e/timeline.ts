/**
 * Timeline builder for E2E simulation.
 *
 * Transforms fixture data into a chronological event stream that can be
 * replayed day by day. This enables realistic simulation where:
 * - PRs stay open until their actual merge day (IN PROGRESS section)
 * - Comments appear on their actual createdAt date
 * - Merges happen at end of their merge day (SHIPPED section)
 */

import { getIncludedCommits, loadDailyFixture } from "../fixtures/loader";
import type { FixtureCommit } from "../fixtures/types";

// Event types in the timeline
export type EventType = "pr_open" | "commit" | "comment" | "pr_merge";

/**
 * A single event in the timeline.
 */
export interface TimelineEvent {
	date: string; // YYYY-MM-DD (for grouping by day)
	timestamp: string; // Full ISO (for ordering within day)
	type: EventType;
	prNumber: number;
	data: PROpenData | CommitData | CommentData | PRMergeData;
}

export interface PROpenData {
	title: string;
	branch: string;
	author: string;
	repo: string;
}

export interface CommitData {
	sha: string;
	message: string;
	diff: string;
	user: string;
}

export interface CommentData {
	id: number;
	body: string;
	author: string;
	createdAt: string;
}

export interface PRMergeData {
	mergedAt: string;
	branch: string;
	title: string;
}

/**
 * Build a chronological timeline of events from fixture data.
 *
 * Uses a two-pass approach to ensure PRs open on their earliest activity date:
 * 1. First pass: scan all fixtures to find earliest activity (commit or comment) for each PR
 * 2. Second pass: build timeline with PRs opening on earliest activity date
 *
 * This ensures PRs show as IN PROGRESS during comment discussions before merge.
 *
 * @param repoShortName - Short repo name (e.g., "excalidraw") used in fixture loader
 * @param fullRepoName - Full repo name (e.g., "excalidraw/excalidraw") for PR URLs
 * @param dates - Sorted array of date strings (YYYY-MM-DD)
 * @returns Sorted array of timeline events
 */
export function buildTimeline(
	repoShortName: string,
	fullRepoName: string,
	dates: string[],
): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	const seenComments = new Set<number>();

	const firstDate = dates[0];
	const lastDate = dates[dates.length - 1];
	if (!firstDate || !lastDate) return events;

	// Data structures for two-pass approach
	interface PRInfo {
		number: number;
		title: string;
		branch: string;
		author: string;
		merged: boolean;
		earliestActivityDate: string;
		earliestActivityTimestamp: string;
		commitDate: string; // Day of merge commit
	}
	const prInfoMap = new Map<number, PRInfo>();
	const prCommits = new Map<
		number,
		{ dateStr: string; commit: FixtureCommit }[]
	>();

	// ============================================
	// FIRST PASS: Find earliest activity for each PR
	// ============================================
	for (const dateStr of dates) {
		const fixture = loadDailyFixture(repoShortName, dateStr);
		const includedCommits = getIncludedCommits(fixture);

		for (const commit of includedCommits) {
			const pr = commit.associatedPR;
			if (!pr) continue;

			// Store commit for this PR
			if (!prCommits.has(pr.number)) {
				prCommits.set(pr.number, []);
			}
			prCommits.get(pr.number)?.push({ dateStr, commit });

			// Find earliest activity date (min of commit date and earliest non-bot comment)
			let earliestDate = dateStr;
			let earliestTimestamp = commit.timestamp;

			for (const comment of pr.comments ?? []) {
				// Skip bot comments for determining open date
				if (comment.author.endsWith("[bot]")) continue;

				const commentDate = comment.createdAt.slice(0, 10);
				// Only consider comments within our date range
				if (commentDate >= firstDate && commentDate <= lastDate) {
					if (commentDate < earliestDate) {
						earliestDate = commentDate;
						earliestTimestamp = comment.createdAt;
					}
				}
			}

			// Update or create PR info
			const existing = prInfoMap.get(pr.number);
			if (!existing || earliestDate < existing.earliestActivityDate) {
				prInfoMap.set(pr.number, {
					number: pr.number,
					title: pr.title,
					branch: pr.branch,
					author: pr.author,
					merged: pr.merged,
					earliestActivityDate: earliestDate,
					earliestActivityTimestamp: earliestTimestamp,
					commitDate: dateStr, // Will be updated to last commit date
				});
			} else {
				// Update commit date to the latest (merge day)
				existing.commitDate = dateStr;
			}
		}
	}

	// ============================================
	// SECOND PASS: Build timeline with correct dates
	// ============================================
	const openedPRs = new Set<number>();

	for (const dateStr of dates) {
		const fixture = loadDailyFixture(repoShortName, dateStr);
		const includedCommits = getIncludedCommits(fixture);

		// Add PR open events for PRs that should open today
		for (const [prNumber, info] of prInfoMap) {
			if (info.earliestActivityDate === dateStr && !openedPRs.has(prNumber)) {
				openedPRs.add(prNumber);
				events.push({
					date: dateStr,
					timestamp: info.earliestActivityTimestamp,
					type: "pr_open",
					prNumber,
					data: {
						title: info.title,
						branch: info.branch,
						author: info.author,
						repo: fullRepoName,
					} as PROpenData,
				});
			}
		}

		for (const commit of includedCommits) {
			const pr = commit.associatedPR;
			if (!pr) continue;

			// Commit event
			events.push({
				date: dateStr,
				timestamp: commit.timestamp,
				type: "commit",
				prNumber: pr.number,
				data: {
					sha: commit.sha,
					message: commit.message,
					diff: commit.diff,
					user: commit.user,
				} as CommitData,
			});

			// Comment events (use their actual createdAt date)
			for (const comment of pr.comments ?? []) {
				if (seenComments.has(comment.id)) continue;
				seenComments.add(comment.id);

				const commentDate = comment.createdAt.slice(0, 10);

				// Only include comments within our date range
				if (commentDate >= firstDate && commentDate <= lastDate) {
					events.push({
						date: commentDate,
						timestamp: comment.createdAt,
						type: "comment",
						prNumber: pr.number,
						data: {
							id: comment.id,
							body: comment.body,
							author: comment.author,
							createdAt: comment.createdAt,
						} as CommentData,
					});
				}
			}
		}
	}

	// Add merge events at end of their merge day
	for (const [prNumber, info] of prInfoMap) {
		if (info.merged) {
			events.push({
				date: info.commitDate,
				timestamp: `${info.commitDate}T23:59:59.000Z`,
				type: "pr_merge",
				prNumber,
				data: {
					mergedAt: `${info.commitDate}T23:59:59.000Z`,
					branch: info.branch,
					title: info.title,
				} as PRMergeData,
			});
		}
	}

	// Sort by timestamp
	return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Get events for a specific day from the timeline.
 */
export function getEventsForDay(
	timeline: TimelineEvent[],
	date: string,
): TimelineEvent[] {
	return timeline.filter((e) => e.date === date);
}

/**
 * Print timeline summary for debugging.
 */
export function printTimelineSummary(timeline: TimelineEvent[]): void {
	const byType = new Map<EventType, number>();
	const byDay = new Map<string, number>();

	for (const event of timeline) {
		byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
		byDay.set(event.date, (byDay.get(event.date) ?? 0) + 1);
	}

	console.log("\nTimeline Summary:");
	console.log("  Events by type:");
	for (const [type, count] of byType) {
		console.log(`    ${type}: ${count}`);
	}
	console.log("  Events by day:");
	for (const [day, count] of byDay) {
		console.log(`    ${day}: ${count}`);
	}
	console.log(`  Total events: ${timeline.length}\n`);
}

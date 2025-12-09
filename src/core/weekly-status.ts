/**
 * RAG status logic for weekly reports.
 * Pure functions for determining report health status.
 */

import type { RAGStatus } from "./weekly-types";

// Configurable thresholds (can be overridden via env)
const RAG_BLOCKER_AGE_THRESHOLD = Number.parseInt(
	process.env.WEEKLY_RAG_BLOCKER_THRESHOLD || "7",
	10,
);
const RAG_BLOCKER_COUNT_THRESHOLD = 3;
const RAG_STALE_REVIEW_THRESHOLD = 3;

export interface RAGInput {
	activeBlockers: Array<{ ageDays: number }>;
	staleReviews: Array<{ daysWaiting: number }>;
}

/**
 * Determine RAG status based on blocker state.
 *
 * 🔴 Red: Any blocker >= 7 days, OR 3+ active blockers
 * 🟡 Yellow: Any active blocker, OR 3+ stale reviews
 * 🟢 Green: No blockers, minimal stale reviews
 */
export function determineRAGStatus(data: RAGInput): RAGStatus {
	const { activeBlockers, staleReviews } = data;

	// 🔴 Red: Any blocker older than threshold, or too many blockers
	const hasOldBlocker = activeBlockers.some(
		(b) => b.ageDays >= RAG_BLOCKER_AGE_THRESHOLD,
	);
	if (hasOldBlocker || activeBlockers.length >= RAG_BLOCKER_COUNT_THRESHOLD) {
		return "red";
	}

	// 🟡 Yellow: Any active blocker, or many stale reviews
	if (
		activeBlockers.length > 0 ||
		staleReviews.length >= RAG_STALE_REVIEW_THRESHOLD
	) {
		return "yellow";
	}

	// 🟢 Green: All clear
	return "green";
}

/**
 * Format RAG status for display.
 */
export function formatRAGStatus(status: RAGStatus): string {
	const labels: Record<RAGStatus, string> = {
		green: "🟢 On Track",
		yellow: "🟡 At Risk",
		red: "🔴 Blocked",
	};
	return labels[status];
}

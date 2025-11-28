/**
 * Watermark calculation for idempotent report tracking.
 * Pure function with no external dependencies.
 */

import type { PRReportData } from "../redis";

/**
 * Calculate the watermark timestamp from report data.
 * Returns the maximum timestamp across all reported items.
 */
export function getWatermark(data: {
	openPRs: Map<number, PRReportData>;
	mergedPRs: Map<number, PRReportData & { blockersResolved: string[] }>;
}): string {
	const timestamps: string[] = [];

	for (const pr of data.mergedPRs.values()) {
		if (pr.meta.mergedAt) timestamps.push(pr.meta.mergedAt);
		for (const t of pr.translations) {
			timestamps.push(t.timestamp);
		}
	}

	for (const pr of data.openPRs.values()) {
		for (const t of pr.translations) {
			timestamps.push(t.timestamp);
		}
	}

	// Return the latest timestamp, or now if no data
	timestamps.sort();
	const latest = timestamps[timestamps.length - 1];
	return latest ?? new Date().toISOString();
}

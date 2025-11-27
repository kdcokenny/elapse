/**
 * Run full work week scenario with AI narration.
 * Generates daily reports using production-aligned fixtures with pre-computed summaries.
 * Calls real AI only for narrateFeature (shipped feature summaries).
 */

import { narrateFeature } from "../../src/ai";
import { generateBlockersSummary } from "../../src/core/blockers";
import {
	type ActivityStats,
	type BranchSummary,
	type FeatureSummary,
	formatFeatureCentricReport,
} from "../../src/core/formatting";
import type { StoredTranslation } from "../../src/redis";
import { generateProgressSection } from "../../src/reporter";
import type { ProductionDayFixture, WorkDay } from "../fixtures/types";
import { loadWorkWeekScenario } from "./work-week-setup";

const SCENARIO_ID = process.argv[2] || "full-week";
const DAYS: WorkDay[] = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
];

async function runDayWithAI(
	fixture: ProductionDayFixture,
	dayName: string,
	dateStr: string,
) {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`  ${dayName.toUpperCase()} - ${dateStr}`);
	console.log(`${"=".repeat(60)}\n`);

	// Convert fixture to Maps (matching production getAllForDate output)
	const shippedMap = new Map<string, StoredTranslation[]>(
		Object.entries(fixture.shipped),
	);
	const progressMap = new Map<string, StoredTranslation[]>(
		Object.entries(fixture.progress),
	);

	// Count translations
	let translationCount = 0;
	for (const translations of shippedMap.values()) {
		translationCount += translations.length;
	}
	for (const translations of progressMap.values()) {
		translationCount += translations.length;
	}

	console.log(`Translations: ${translationCount} (pre-computed)`);
	console.log(`Blockers: ${fixture.blockers.length}`);

	// Generate feature summaries for shipped PRs using AI
	const shipped: FeatureSummary[] = [];

	// Group shipped translations by PR
	const byPR = new Map<
		number,
		{
			prNumber: number;
			prTitle: string;
			translations: StoredTranslation[];
			authors: Set<string>;
		}
	>();

	for (const [user, translations] of shippedMap) {
		for (const t of translations) {
			if (!t.prNumber) continue;

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
		}
	}

	// Call real AI for each shipped PR
	for (const [prNumber, prData] of byPR) {
		const summaries = prData.translations.map((t) => t.summary);

		console.log(`\nNarrating PR #${prNumber}: ${prData.prTitle}...`);
		const { featureName, impact } = await narrateFeature(
			prData.prTitle,
			prNumber,
			summaries,
		);

		console.log(`  Feature: ${featureName}`);
		console.log(`  Impact: ${impact}`);

		shipped.push({
			featureName,
			impact,
			prNumber,
			authors: Array.from(prData.authors),
			commitCount: prData.translations.length,
		});
	}

	// Use production function for progress section
	const inProgress: BranchSummary[] = generateProgressSection(progressMap);

	console.log(`\nIn Progress: ${inProgress.length} branches`);
	for (const p of inProgress) {
		console.log(
			`  - ${p.branch}: ${p.commitCount} commits (${p.users.join(", ")})`,
		);
	}

	// Build stats
	const stats: ActivityStats = {
		prsMerged: shipped.length,
		branchesActive: inProgress.length,
		totalCommits: translationCount,
		blockerCount: fixture.blockers.length,
	};

	// Generate report
	const blockerSummaries = generateBlockersSummary(fixture.blockers);
	const report = formatFeatureCentricReport(
		dateStr,
		blockerSummaries,
		shipped,
		inProgress,
		stats,
	);

	console.log(`\n${"─".repeat(60)}`);
	console.log("GENERATED REPORT:");
	console.log(`${"─".repeat(60)}`);
	console.log(report);

	return {
		translations: translationCount,
		shipped: shipped.length,
		blockers: fixture.blockers.length,
	};
}

async function main() {
	console.log(`\n${"═".repeat(60)}`);
	console.log(`  FULL WEEK EXECUTION: ${SCENARIO_ID}`);
	console.log(`${"═".repeat(60)}`);

	const scenario = loadWorkWeekScenario(SCENARIO_ID);
	if (!scenario) {
		console.error(`Scenario "${SCENARIO_ID}" not found`);
		process.exit(1);
	}

	console.log(`Scenario: ${scenario.name}`);
	console.log(`Description: ${scenario.description}`);

	const summary: Record<
		string,
		{ translations: number; shipped: number; blockers: number }
	> = {};

	for (let i = 0; i < DAYS.length; i++) {
		const dayName = DAYS[i];
		if (!dayName) continue;

		const dayData = scenario.days.get(dayName);

		if (!dayData) {
			console.log(`\n${dayName.toUpperCase()}: No data`);
			continue;
		}

		// Calculate date (Monday = 24, Tuesday = 25, etc.)
		const dayNum = 24 + i;
		const dateStr = `2025-02-${dayNum}`;

		summary[dayName] = await runDayWithAI(dayData, dayName, dateStr);
	}

	// Final summary
	console.log(`\n${"═".repeat(60)}`);
	console.log("  WEEK SUMMARY");
	console.log(`${"═".repeat(60)}`);

	for (const [day, data] of Object.entries(summary)) {
		console.log(
			`${day.padEnd(12)} | ${data.translations} translations | ${data.shipped} shipped | ${data.blockers} blockers`,
		);
	}
}

main().catch(console.error);

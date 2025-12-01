/**
 * Webhook Event Simulator for E2E Tests.
 *
 * Simulates GitHub webhook events by calling the same Redis functions
 * that the production webhook handlers call. This ensures E2E tests
 * exercise the full code path including the branch-to-PR index.
 */

import type { PRTranslation } from "../../src/redis";
import {
	addPRToDay,
	addPRTranslation,
	clearBranchPR,
	closePR,
	createOrUpdatePR,
	getBranchPR,
	setBranchPR,
} from "../../src/redis";
import type { FixtureCommit, FixturePR } from "../fixtures/types";

/**
 * Translation result from AI or mock.
 */
export interface TranslationResult {
	summary: string;
	category: string | null;
	significance: string | null;
}

/**
 * Translation function signature.
 */
export type TranslateFn = (
	diff: string,
	message: string,
) => Promise<TranslationResult>;

/**
 * Simulate a PR being opened.
 * Mirrors the pull_request.opened webhook handler behavior.
 */
export async function simulatePROpened(
	repo: string,
	pr: FixturePR,
): Promise<void> {
	await createOrUpdatePR(pr.number, {
		repo,
		branch: pr.branch,
		title: pr.title,
		authors: [pr.author],
		status: "open",
		openedAt: new Date().toISOString(),
	});

	// Index branch -> PR for push event association
	await setBranchPR(repo, pr.branch, pr.number);
}

/**
 * Simulate a push event with commit.
 * Mirrors the push webhook handler behavior.
 */
export async function simulatePush(
	repo: string,
	branch: string,
	commit: FixtureCommit,
	translateFn: TranslateFn,
): Promise<{ prNumber: number | undefined; translation: PRTranslation }> {
	// Look up PR number from branch index (set when PR is opened)
	const prNumber = await getBranchPR(repo, branch);

	// Translate the commit
	const result = await translateFn(commit.diff, commit.message);

	const translation: PRTranslation = {
		sha: commit.sha,
		summary: result.summary,
		category: result.category,
		significance: result.significance,
		author: commit.user,
		timestamp: commit.timestamp,
	};

	// Store translation and index if we have a PR number
	if (prNumber) {
		await addPRTranslation(prNumber, translation);
		const date = commit.timestamp.split("T")[0] ?? "";
		if (date) {
			await addPRToDay(date, prNumber);
		}
	}

	return { prNumber, translation };
}

/**
 * Simulate a PR being merged.
 * Mirrors the pull_request.closed (merged=true) webhook handler behavior.
 */
export async function simulatePRMerged(
	repo: string,
	pr: FixturePR,
): Promise<void> {
	await closePR(pr.number, true);
	await clearBranchPR(repo, pr.branch);
}

/**
 * Simulate a PR being closed without merge.
 * Mirrors the pull_request.closed (merged=false) webhook handler behavior.
 */
export async function simulatePRClosed(
	repo: string,
	pr: FixturePR,
): Promise<void> {
	await closePR(pr.number, false);
	await clearBranchPR(repo, pr.branch);
}

/**
 * Mock translation function for tests that don't need real AI.
 * Returns a simple summary based on the commit message.
 */
export function createMockTranslator(): TranslateFn {
	return async (_diff: string, message: string): Promise<TranslationResult> => {
		// Extract first line of message
		const firstLine = message.split("\n")[0] ?? message;

		return {
			summary: `[Mock] ${firstLine}`,
			category: "feature",
			significance: "medium",
		};
	};
}

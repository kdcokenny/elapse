/**
 * Webhook Event Simulator for E2E Tests.
 *
 * Simulates GitHub webhook events by calling the same Redis functions
 * that the production webhook handlers call. Branch-first architecture:
 * commits are stored by branch, resolved to PRs at read time.
 */

import {
	addBranchCommit,
	type BranchCommit,
	closePR,
	createOrUpdatePR,
	recordPRMerged,
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
 * Branch-first: just store PR metadata, no branch index needed.
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
	// No branch->PR index - read-time resolution handles association
}

/**
 * Simulate a push event with commit.
 * Mirrors the push webhook handler behavior.
 * Branch-first: stores commit by branch, no PR lookup needed.
 */
export async function simulatePush(
	repo: string,
	branch: string,
	commit: FixtureCommit,
	translateFn: TranslateFn,
): Promise<{ translation: BranchCommit }> {
	// Translate the commit
	const result = await translateFn(commit.diff, commit.message);

	const translation: BranchCommit = {
		sha: commit.sha,
		summary: result.summary,
		category: result.category,
		significance: result.significance,
		author: commit.user,
		timestamp: commit.timestamp,
	};

	// Store by branch - PR association happens at read time
	await addBranchCommit(repo, branch, translation);

	return { translation };
}

/**
 * Simulate a PR being merged.
 * Mirrors the pull_request.closed (merged=true) webhook handler behavior.
 * Branch-first: records merged PR to daily index, no branch cleanup.
 */
export async function simulatePRMerged(
	pr: FixturePR,
	date: string,
): Promise<void> {
	await closePR(pr.number, true);
	await recordPRMerged(pr.number, date);
}

/**
 * Simulate a PR being closed without merge.
 * Mirrors the pull_request.closed (merged=false) webhook handler behavior.
 * Branch-first: no branch cleanup needed.
 */
export async function simulatePRClosed(pr: FixturePR): Promise<void> {
	await closePR(pr.number, false);
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

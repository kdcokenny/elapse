/**
 * BullMQ worker for processing commit digestion jobs.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { analyzeComment, translateDiff } from "./ai";
import { classifyBranch } from "./core/branches";
import { getPrivateKey } from "./credentials";
import { DiffTooLargeError, GitHubAPIError, NonRetryableError } from "./errors";
import { workerLogger } from "./logger";
import {
	addDirectCommit,
	addPRToDay,
	addPRTranslation,
	createOrUpdatePR,
	getPRBlockers,
	redis,
	removePRBlocker,
	setPRBlocker,
} from "./redis";
import type { CommentJob, DigestJob } from "./webhook";

const MAX_DIFF_SIZE = 100000; // 100KB - skip larger diffs
const QUEUE_NAME = "elapse";

// Type guard for errors with HTTP status
function hasStatus(error: unknown): error is { status: number } {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		typeof (error as { status: unknown }).status === "number"
	);
}

/**
 * Create an authenticated Octokit instance for an installation.
 */
function getOctokit(installationId: number): Octokit {
	const appId = process.env.GITHUB_APP_ID;
	const privateKey = getPrivateKey();

	if (!appId || !privateKey) {
		throw new Error(
			"Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables",
		);
	}

	return new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId,
			privateKey,
			installationId,
		},
	});
}

/**
 * Fetch the diff for a commit from GitHub.
 */
async function fetchDiff(
	octokit: Octokit,
	owner: string,
	repo: string,
	sha: string,
): Promise<string> {
	const response = await octokit.repos.getCommit({
		owner,
		repo,
		ref: sha,
		mediaType: {
			format: "diff",
		},
	});

	// When requesting diff format, response.data is a string
	return response.data as unknown as string;
}

/**
 * Process a single digest job.
 */
async function processDigestJob(
	job: Job<DigestJob>,
): Promise<{ translation: string; section: string }> {
	const {
		repo,
		user,
		sha,
		message,
		installationId,
		timestamp,
		branch,
		prNumber,
	} = job.data;
	const [owner = "", repoName = ""] = repo.split("/");

	// Classify the branch to determine section
	const section = classifyBranch(branch);

	const log = workerLogger.child({
		jobId: job.id,
		repo,
		sha: sha.slice(0, 7),
		user,
		branch,
		section,
		prNumber,
	});

	log.info("Processing commit");

	try {
		// Get authenticated GitHub client
		const octokit = getOctokit(installationId);

		// Fetch diff
		const diff = await fetchDiff(octokit, owner, repoName, sha);

		// Check diff size
		if (diff.length > MAX_DIFF_SIZE) {
			log.warn({ diffSize: diff.length }, "Diff too large, skipping");
			throw new DiffTooLargeError(diff.length, MAX_DIFF_SIZE);
		}

		if (!diff || diff.length === 0) {
			log.debug("Empty diff, skipping");
			return { translation: "SKIP", section };
		}

		// Translate diff to business value
		const result = await translateDiff(message, diff);

		log.debug({ result }, "Translation result");

		// Skip trivial changes
		if (result.action === "skip") {
			log.debug("Translation skipped as trivial");
			return { translation: "SKIP", section };
		}

		// Validate: action=include requires a summary
		if (!result.summary) {
			log.warn("AI returned include without summary, treating as skip");
			return { translation: "SKIP", section };
		}

		const summary = result.summary;
		const date = timestamp.split("T")[0] ?? timestamp; // YYYY-MM-DD

		// PR-centric storage: route based on whether this commit is PR-associated
		if (prNumber) {
			const prTitle = `PR #${prNumber}`;

			// Create or update PR metadata
			await createOrUpdatePR(prNumber, {
				repo,
				branch,
				title: prTitle,
				authors: [user],
				status: "open",
			});

			// Add translation to PR
			await addPRTranslation(prNumber, {
				sha,
				summary,
				category: result.category,
				significance: result.significance,
				author: user,
				timestamp,
			});

			// Add PR to daily index
			await addPRToDay(date, prNumber);
		} else {
			// Direct commit (no PR) - store in direct commits bucket
			await addDirectCommit(date, {
				summary,
				category: result.category,
				significance: result.significance,
				branch,
				sha,
			});
		}

		log.info("Commit processed successfully");
		return { translation: summary, section };
	} catch (error) {
		// Non-retryable errors should fail immediately
		if (error instanceof NonRetryableError) {
			log.warn({ err: error }, "Non-retryable error, failing job");
			throw new UnrecoverableError((error as Error).message);
		}

		// GitHub API errors
		if (hasStatus(error) && error.status === 404) {
			log.warn("Commit not found (may have been force-pushed), skipping");
			throw new UnrecoverableError("Commit not found");
		}

		if (hasStatus(error) && error.status === 403) {
			throw new GitHubAPIError(
				"GitHub API rate limit or permission error",
				60000,
				error instanceof Error ? error : undefined,
			);
		}

		// Let BullMQ retry other errors
		log.error({ err: error }, "Error processing commit, will retry");
		throw error;
	}
}

/**
 * Process a PR comment job - analyze for blocker signals.
 */
async function processCommentJob(
	job: Job<CommentJob>,
): Promise<{ action: string }> {
	const { repo, prNumber, prTitle, commentId, commentBody, author } = job.data;

	const log = workerLogger.child({
		jobId: job.id,
		repo,
		prNumber,
		commentId,
		author,
	});

	log.info("Analyzing PR comment for blockers");

	try {
		// Use AI to analyze the comment
		const result = await analyzeComment(commentBody, {
			title: prTitle,
			number: prNumber,
		});

		if (result.action === "add_blocker" && result.description) {
			// Store the blocker in PR-centric storage
			await setPRBlocker(prNumber, `comment:${commentId}`, {
				type: "comment",
				description: result.description,
				commentId,
				detectedAt: new Date().toISOString(),
			});

			log.info(
				{ description: result.description },
				"Blocker detected from comment",
			);
		} else if (result.action === "resolve_blocker") {
			// Remove all blockers from PR-centric storage when a resolution is detected
			const blockers = await getPRBlockers(prNumber);
			for (const [key] of blockers) {
				await removePRBlocker(prNumber, key);
			}

			log.info(
				{ prBlockersRemoved: blockers.size },
				"Blockers resolved from comment",
			);
		} else {
			log.debug("Comment did not indicate a blocker");
		}

		return { action: result.action };
	} catch (error) {
		// Non-retryable for most comment analysis errors
		if (hasStatus(error) && error.status === 403) {
			throw new GitHubAPIError(
				"GitHub API rate limit or permission error",
				60000,
				error instanceof Error ? error : undefined,
			);
		}

		log.error({ err: error }, "Error analyzing comment, will retry");
		throw error;
	}
}

// Job type union for worker
type ElapseJob = DigestJob | CommentJob;

/**
 * Process any job - routes to the appropriate processor.
 */
async function processJob(job: Job<ElapseJob>): Promise<unknown> {
	if (job.name === "comment") {
		return processCommentJob(job as Job<CommentJob>);
	}
	return processDigestJob(job as Job<DigestJob>);
}

/**
 * Create and start the BullMQ worker.
 */
export function createWorker(): Worker<ElapseJob> {
	const worker = new Worker<ElapseJob>(QUEUE_NAME, processJob, {
		connection: redis,
		concurrency: 5,
	});

	// Log worker events
	worker.on("completed", (job) => {
		workerLogger.debug(
			{
				jobId: job.id,
				duration: Date.now() - job.timestamp,
			},
			"Job completed",
		);
	});

	worker.on("failed", (job, error) => {
		workerLogger.error(
			{
				jobId: job?.id,
				err: error,
				attempts: job?.attemptsMade,
			},
			"Job failed",
		);
	});

	worker.on("stalled", (jobId) => {
		workerLogger.warn({ jobId }, "Job stalled");
	});

	worker.on("error", (error) => {
		workerLogger.error({ err: error }, "Worker error");
	});

	workerLogger.info("Digest worker started");

	return worker;
}

export { QUEUE_NAME };

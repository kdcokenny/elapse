/**
 * BullMQ worker for processing all job types (digest, comment, report).
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
	addBranchCommit,
	addDirectCommit,
	getPRBlockers,
	redis,
	resolvePRBlocker,
	setPRBlocker,
} from "./redis";
import { processReportJob, type ReportJob } from "./reporter";
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
 * Branch-first architecture: commits are stored by branch, resolved to PRs at read time.
 */
async function processDigestJob(
	job: Job<DigestJob>,
): Promise<{ translation: string; section: string }> {
	const { repo, user, sha, message, installationId, timestamp, branch } =
		job.data;
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

		// Branch-first storage: route based on branch type
		if (section === "shipped") {
			// Main branch commits go to direct commits (no PR association)
			await addDirectCommit(date, {
				summary,
				category: result.category,
				significance: result.significance,
				branch,
				sha,
			});
		} else {
			// Feature branch commits go to branch storage
			// PR association happens at read time (report generation)
			await addBranchCommit(repo, branch, {
				sha,
				summary,
				category: result.category,
				significance: result.significance,
				author: user,
				timestamp,
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
			// Store the blocker in PR-centric storage (with @mentions if extracted)
			await setPRBlocker(prNumber, `comment:${commentId}`, {
				type: "comment",
				description: result.description,
				commentId,
				detectedAt: new Date().toISOString(),
				mentionedUsers: result.mentionedUsers || [],
			});

			log.info(
				{
					description: result.description,
					mentionedUsers: result.mentionedUsers,
				},
				"Blocker detected from comment",
			);
		} else if (result.action === "resolve_blocker") {
			// Mark all blockers as resolved (soft delete with resolvedAt)
			const blockers = await getPRBlockers(prNumber);
			for (const [key, blocker] of blockers) {
				// Skip already-resolved blockers
				if (!blocker.resolvedAt) {
					await resolvePRBlocker(prNumber, key);
				}
			}

			log.info(
				{ prBlockersResolved: blockers.size },
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
type ElapseJob = DigestJob | CommentJob | ReportJob;

/**
 * Process any job - routes to the appropriate processor.
 * Fails fast with UnrecoverableError for unknown job types.
 */
async function processJob(job: Job<ElapseJob>): Promise<unknown> {
	switch (job.name) {
		case "digest":
			return processDigestJob(job as Job<DigestJob>);
		case "comment":
			return processCommentJob(job as Job<CommentJob>);
		case "report":
			return processReportJob(job as Job<ReportJob>);
		default:
			throw new UnrecoverableError(`Unknown job type: ${job.name}`);
	}
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

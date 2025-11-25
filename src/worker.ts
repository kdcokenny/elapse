/**
 * BullMQ worker for processing commit digestion jobs.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { translateDiff } from "./ai";
import { DiffTooLargeError, GitHubAPIError, NonRetryableError } from "./errors";
import { workerLogger } from "./logger";
import { redis, storeTranslation } from "./redis";
import type { DigestJob } from "./webhook";

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
	const appId = process.env.APP_ID;
	const privateKey = process.env.PRIVATE_KEY;

	if (!appId || !privateKey) {
		throw new Error("Missing APP_ID or PRIVATE_KEY environment variables");
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
): Promise<{ translation: string }> {
	const { repo, user, sha, message, installationId, timestamp } = job.data;
	const [owner = "", repoName = ""] = repo.split("/");

	const log = workerLogger.child({
		jobId: job.id,
		repo,
		sha: sha.slice(0, 7),
		user,
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
			return { translation: "SKIP" };
		}

		// Translate diff to business value
		const translation = await translateDiff(message, diff);

		log.debug({ translation }, "Translation result");

		// Store in Redis
		const date = timestamp.split("T")[0] ?? timestamp; // YYYY-MM-DD
		await storeTranslation(date, user, translation);

		log.info("Commit processed successfully");
		return { translation };
	} catch (error) {
		// Non-retryable errors should fail immediately
		if (error instanceof NonRetryableError) {
			log.warn({ error }, "Non-retryable error, failing job");
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
		log.error({ error }, "Error processing commit, will retry");
		throw error;
	}
}

/**
 * Create and start the BullMQ worker.
 */
export function createWorker(): Worker<DigestJob> {
	const worker = new Worker<DigestJob>(QUEUE_NAME, processDigestJob, {
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
				error,
				attempts: job?.attemptsMade,
			},
			"Job failed",
		);
	});

	worker.on("stalled", (jobId) => {
		workerLogger.warn({ jobId }, "Job stalled");
	});

	worker.on("error", (error) => {
		workerLogger.error({ error }, "Worker error");
	});

	workerLogger.info("Digest worker started");

	return worker;
}

export { QUEUE_NAME };

/**
 * BullMQ worker for processing commit digestion jobs.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { type Job, UnrecoverableError, Worker } from "bullmq";
import { analyzeComment, translateDiff } from "./ai";
import {
	type BlockerResult,
	isBlockerLabel,
	type PRBlocker,
	parseCommitBlockers,
	parseDescriptionBlockers,
} from "./core/blockers";
import { classifyBranch } from "./core/branches";
import { getPrivateKey } from "./credentials";
import { DiffTooLargeError, GitHubAPIError, NonRetryableError } from "./errors";
import { workerLogger } from "./logger";
import {
	redis,
	resolveBlockersForPR,
	storeBlockers,
	storePersistentBlocker,
	storeTranslation,
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

// Enable/disable blocker extraction via env
const EXTRACT_BLOCKERS = process.env.EXTRACT_BLOCKERS !== "false";

/**
 * Extract blockers from PR data for a branch.
 */
async function extractBlockersFromPR(
	octokit: Octokit,
	owner: string,
	repo: string,
	branch: string,
	user: string,
	message: string,
): Promise<BlockerResult | null> {
	const blockers: PRBlocker[] = [];

	// First, check commit message for blocker signals
	const commitSignals = parseCommitBlockers(message);
	for (const signal of commitSignals) {
		blockers.push({
			type: "commit_signal",
			description:
				signal.type === "depends" && signal.dependency
					? `Depends on #${signal.dependency}`
					: `${signal.type.toUpperCase()} noted in commit`,
			branch,
			user,
		});
	}

	// Find open PR for this branch
	try {
		const { data: prs } = await octokit.pulls.list({
			owner,
			repo,
			head: `${owner}:${branch}`,
			state: "open",
		});

		if (prs.length === 0) {
			// No PR yet - only commit message blockers
			return blockers.length > 0 ? { blockers } : null;
		}

		const pr = prs[0];
		if (!pr) return blockers.length > 0 ? { blockers } : null;

		// Check for blocking labels
		for (const label of pr.labels) {
			const name = typeof label === "string" ? label : label.name;
			if (name && isBlockerLabel(name)) {
				blockers.push({
					type: "label",
					description: `PR #${pr.number} labeled "${name}"`,
					prNumber: pr.number,
					branch,
					user,
				});
			}
		}

		// Parse description for blocker section
		const descriptionBlocker = parseDescriptionBlockers(pr.body);
		if (descriptionBlocker) {
			blockers.push({
				type: "description",
				description: descriptionBlocker,
				prNumber: pr.number,
				branch,
				user,
			});
		}

		// Check pending reviewers
		const pendingReviewers = pr.requested_reviewers || [];
		for (const reviewer of pendingReviewers) {
			if (reviewer && "login" in reviewer) {
				blockers.push({
					type: "pending_review",
					description: `Waiting on review from @${reviewer.login}`,
					reviewer: reviewer.login,
					prNumber: pr.number,
					branch,
					user,
				});
			}
		}

		// Check for CHANGES_REQUESTED reviews
		const { data: reviews } = await octokit.pulls.listReviews({
			owner,
			repo,
			pull_number: pr.number,
		});

		// Get latest review per reviewer
		const latestByReviewer = new Map<string, (typeof reviews)[0]>();
		for (const review of reviews) {
			if (review.user?.login) {
				latestByReviewer.set(review.user.login, review);
			}
		}

		for (const [reviewer, review] of latestByReviewer) {
			if (review.state === "CHANGES_REQUESTED") {
				blockers.push({
					type: "changes_requested",
					description: `Changes requested by @${reviewer}`,
					reviewer,
					prNumber: pr.number,
					branch,
					user,
				});
			}
		}

		return {
			blockers,
			prTitle: pr.title,
			prUrl: pr.html_url,
		};
	} catch (error) {
		// Non-critical - just skip blocker extraction on error
		workerLogger.debug(
			{ err: error, branch },
			"Failed to extract blockers from PR",
		);
		return blockers.length > 0 ? { blockers } : null;
	}
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

		// Store in Redis with section and metadata
		const date = timestamp.split("T")[0] ?? timestamp; // YYYY-MM-DD
		await storeTranslation(date, user, section, {
			summary: result.summary ?? "",
			category: result.category,
			significance: result.significance,
			branch,
			prNumber,
			sha,
		});

		// Extract blockers for non-main branches
		if (section === "progress" && EXTRACT_BLOCKERS) {
			const blockerResult = await extractBlockersFromPR(
				octokit,
				owner,
				repoName,
				branch,
				user,
				message,
			);

			if (blockerResult?.blockers.length) {
				await storeBlockers(date, blockerResult.blockers);
				log.debug(
					{ blockerCount: blockerResult.blockers.length },
					"Stored blockers",
				);
			}
		}

		log.info("Commit processed successfully");
		return { translation: result.summary ?? "", section };
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
	const { repo, prNumber, prTitle, branch, commentId, commentBody, author } =
		job.data;

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
			// Store the blocker
			await storePersistentBlocker({
				type: "comment",
				description: result.description,
				branch,
				user: author,
				prNumber,
				commentId,
				detectedAt: new Date().toISOString(),
			});

			log.info(
				{ description: result.description },
				"Blocker detected from comment",
			);
		} else if (result.action === "resolve_blocker") {
			// Resolve blockers for this PR
			const removed = await resolveBlockersForPR(repo, prNumber);
			log.info({ removed }, "Blockers resolved from comment");
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

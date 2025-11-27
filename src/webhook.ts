/**
 * Probot webhook handler for push events.
 * Filters commits and adds digestion jobs to BullMQ.
 */

import type { Queue } from "bullmq";
import type { Probot } from "probot";
import { extractBranchFromRef } from "./core/branches";
import { type Commit, filterCommits, type Sender } from "./core/filters";
import { webhookLogger } from "./logger";
import {
	resolveBlockersForPR,
	resolveReviewBlocker,
	storeReviewBlocker,
} from "./redis";

export interface DigestJob {
	repo: string;
	user: string;
	sha: string;
	message: string;
	installationId: number;
	timestamp: string;
	branch: string;
	prNumber?: number;
}

export interface CommentJob {
	repo: string;
	prNumber: number;
	prTitle: string;
	branch: string;
	commentId: number;
	commentBody: string;
	author: string;
	installationId: number;
	timestamp: string;
}

/**
 * Extract PR number from commit message.
 * GitHub includes PR numbers in squash/merge commits: `feat: add auth (#234)`
 */
function extractPrNumber(message: string): number | undefined {
	// Match PR number at end of first line: "message (#123)"
	const firstLine = message.split("\n")[0] ?? "";
	const match = firstLine.match(/\(#(\d+)\)$/);
	if (match?.[1]) {
		return parseInt(match[1], 10);
	}
	return undefined;
}

export const JOB_OPTIONS = {
	attempts: 5,
	backoff: {
		type: "exponential" as const,
		delay: 2000,
	},
	removeOnComplete: {
		age: 86400, // 24 hours
	},
	removeOnFail: {
		age: 604800, // 7 days
	},
};

/**
 * Create the Probot webhook app.
 */
export function createWebhookApp(queue: Queue) {
	return (app: Probot) => {
		app.on("push", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				// Extract repository info
				const repo = payload.repository.full_name;
				const installationId = payload.installation?.id;
				const branch = extractBranchFromRef(payload.ref);

				if (!installationId) {
					log.warn({ repo }, "Push event missing installation ID, skipping");
					return;
				}

				// Map webhook commits to our Commit interface
				const commits: Commit[] = payload.commits.map((c) => ({
					id: c.id,
					message: c.message,
					author: {
						name: c.author.name,
						email: c.author.email,
						username: c.author.username,
					},
					added: c.added,
					modified: c.modified,
					removed: c.removed,
				}));

				// Map sender to our Sender interface
				const sender: Sender = {
					login: payload.sender?.login || "unknown",
					type: payload.sender?.type,
				};

				// Filter commits
				const { included, excluded } = filterCommits(commits, sender);

				if (excluded.length > 0) {
					log.debug(
						{
							repo,
							excluded: excluded.map((e) => ({
								sha: e.commit.id.slice(0, 7),
								reason: e.reason,
							})),
						},
						"Excluded commits",
					);
				}

				if (included.length === 0) {
					log.debug({ repo }, "No commits to process after filtering");
					return;
				}

				// Add jobs for each included commit
				const timestamp = new Date().toISOString();

				for (const commit of included) {
					const jobData: DigestJob = {
						repo,
						user: commit.author.username ?? commit.author.name ?? sender.login,
						sha: commit.id,
						message: commit.message,
						installationId,
						timestamp,
						branch,
						prNumber: extractPrNumber(commit.message),
					};

					await queue.add("digest", jobData, JOB_OPTIONS);

					log.debug(
						{
							repo,
							sha: commit.id.slice(0, 7),
							user: jobData.user,
							branch,
							prNumber: jobData.prNumber,
						},
						"Queued commit for digestion",
					);
				}

				log.info(
					{ repo, branch, queued: included.length, filtered: excluded.length },
					"Processed push event",
				);
			} catch (error) {
				// Log but don't throw - webhook must return 200
				log.error({ err: error }, "Failed to process push event");
			}
		});

		// Handle PR comments for blocker detection
		app.on("issue_comment.created", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				// Only process PR comments (not issue comments)
				if (!payload.issue.pull_request) {
					return;
				}

				// Skip bot comments
				if (payload.comment.user?.type === "Bot") {
					log.debug(
						{ repo: payload.repository.full_name },
						"Skipping bot comment",
					);
					return;
				}

				const repo = payload.repository.full_name;
				const installationId = payload.installation?.id;
				const prNumber = payload.issue.number;
				const prTitle = payload.issue.title;
				const commentId = payload.comment.id;
				const commentBody = payload.comment.body;
				const author = payload.comment.user?.login ?? "unknown";

				if (!installationId) {
					log.warn({ repo }, "Comment event missing installation ID, skipping");
					return;
				}

				// We need to fetch the PR to get the branch
				// The issue_comment payload doesn't include PR details
				const [owner, repoName] = repo.split("/");

				if (!owner || !repoName) {
					log.warn({ repo }, "Invalid repo format, skipping");
					return;
				}

				const { data: pr } = await context.octokit.rest.pulls.get({
					owner,
					repo: repoName,
					pull_number: prNumber,
				});

				const jobData: CommentJob = {
					repo,
					prNumber,
					prTitle,
					branch: pr.head.ref,
					commentId,
					commentBody,
					author,
					installationId,
					timestamp: new Date().toISOString(),
				};

				await queue.add("comment", jobData, JOB_OPTIONS);

				log.debug(
					{ repo, prNumber, commentId, author },
					"Queued comment for analysis",
				);
			} catch (error) {
				log.error({ err: error }, "Failed to process comment event");
			}
		});

		// Handle PR merges to auto-resolve blockers
		app.on("pull_request.closed", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				// Only process merged PRs
				if (!payload.pull_request.merged) {
					return;
				}

				const repo = payload.repository.full_name;
				const prNumber = payload.pull_request.number;

				// Remove all blockers for this PR
				const removed = await resolveBlockersForPR(repo, prNumber);

				if (removed > 0) {
					log.info(
						{ repo, prNumber, blockerCount: removed },
						"Resolved blockers for merged PR",
					);
				} else {
					log.debug({ repo, prNumber }, "PR merged, no blockers to resolve");
				}
			} catch (error) {
				log.error({ err: error }, "Failed to process PR merge event");
			}
		});

		// Handle PR reviews for real-time blocker detection
		app.on(
			["pull_request_review.submitted", "pull_request_review.dismissed"],
			async (context) => {
				const { payload } = context;
				const log = webhookLogger.child({ delivery: context.id });

				try {
					const repo = payload.repository.full_name;
					const prNumber = payload.pull_request.number;
					const prTitle = payload.pull_request.title;
					const branch = payload.pull_request.head.ref;
					const prAuthor = payload.pull_request.user?.login ?? "unknown";
					const reviewer = payload.review.user?.login;
					const reviewState = payload.review.state;

					if (!reviewer) {
						log.debug({ repo, prNumber }, "Review event missing reviewer");
						return;
					}

					// Handle review submitted
					if (payload.action === "submitted") {
						if (reviewState === "changes_requested") {
							// Store blocker for this reviewer
							await storeReviewBlocker({
								type: "changes_requested",
								description: `Changes requested by @${reviewer}`,
								reviewer,
								prNumber,
								prTitle,
								branch,
								user: prAuthor,
								detectedAt: new Date().toISOString(),
							});

							log.info(
								{ repo, prNumber, reviewer },
								"Stored changes_requested blocker from review",
							);
						} else if (reviewState === "approved") {
							// Resolve this reviewer's blocker (if any)
							const resolved = await resolveReviewBlocker(prNumber, reviewer);
							if (resolved) {
								log.info(
									{ repo, prNumber, reviewer },
									"Resolved blocker after approval",
								);
							}
						}
					}

					// Handle review dismissed
					if (payload.action === "dismissed") {
						const resolved = await resolveReviewBlocker(prNumber, reviewer);
						if (resolved) {
							log.info(
								{ repo, prNumber, reviewer },
								"Resolved blocker after review dismissed",
							);
						}
					}
				} catch (error) {
					log.error({ err: error }, "Failed to process review event");
				}
			},
		);

		// Log app startup
		app.log.info("Elapse webhook handler loaded");
	};
}

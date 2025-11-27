/**
 * Probot webhook handler for push events.
 * Filters commits and adds digestion jobs to BullMQ.
 */

import type { Queue } from "bullmq";
import type { Probot } from "probot";
import { isBlockerLabel, parseDescriptionBlockers } from "./core/blockers";
import { extractBranchFromRef } from "./core/branches";
import { type Commit, filterCommits, type Sender } from "./core/filters";
import { webhookLogger } from "./logger";
import {
	closePR,
	createOrUpdatePR,
	removePRBlocker,
	resolveBlockersForPR,
	resolveReviewBlocker,
	setPRBlocker,
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

		// Handle PR opened - create PR metadata
		app.on("pull_request.opened", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				const prNumber = payload.pull_request.number;
				const repo = payload.repository.full_name;
				const branch = payload.pull_request.head.ref;
				const title = payload.pull_request.title;
				const author = payload.pull_request.user?.login ?? "unknown";

				await createOrUpdatePR(prNumber, {
					repo,
					branch,
					title,
					authors: [author],
					status: "open",
					openedAt: new Date().toISOString(),
				});

				log.info({ repo, prNumber, branch }, "PR opened, metadata stored");
			} catch (error) {
				log.error({ err: error }, "Failed to process PR opened event");
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

		// Handle PR closed (merged or not) - update PR status and cleanup
		app.on("pull_request.closed", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				const repo = payload.repository.full_name;
				const prNumber = payload.pull_request.number;
				const merged = payload.pull_request.merged;

				// Close PR in PR-centric storage (sets status, applies TTL, cleans up blockers if not merged)
				await closePR(prNumber, merged);

				// Also resolve blockers in legacy storage for backwards compatibility
				const removed = await resolveBlockersForPR(repo, prNumber);

				log.info(
					{ repo, prNumber, merged, blockerCount: removed },
					merged ? "PR merged, data archived" : "PR closed, data cleaned up",
				);
			} catch (error) {
				log.error({ err: error }, "Failed to process PR closed event");
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
							// Store blocker in PR-centric storage
							await setPRBlocker(prNumber, `review:${reviewer}`, {
								type: "changes_requested",
								description: `Changes requested by @${reviewer}`,
								reviewer,
								detectedAt: new Date().toISOString(),
							});

							// Also store in legacy storage for backwards compatibility
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
							// Resolve this reviewer's blocker in PR-centric storage
							await removePRBlocker(prNumber, `review:${reviewer}`);

							// Also resolve in legacy storage
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
						// Remove from PR-centric storage
						await removePRBlocker(prNumber, `review:${reviewer}`);

						// Also remove from legacy storage
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

		// Handle PR labels for real-time blocker detection
		app.on(
			["pull_request.labeled", "pull_request.unlabeled"],
			async (context) => {
				const { payload } = context;
				const log = webhookLogger.child({ delivery: context.id });

				try {
					const repo = payload.repository.full_name;
					const prNumber = payload.pull_request.number;
					const label = payload.label;

					if (!label?.name) {
						log.debug({ repo, prNumber }, "Label event missing label name");
						return;
					}

					// Only process blocker labels
					if (!isBlockerLabel(label.name)) {
						return;
					}

					if (payload.action === "labeled") {
						await setPRBlocker(prNumber, `label:${label.name}`, {
							type: "label",
							description: `PR labeled "${label.name}"`,
							detectedAt: new Date().toISOString(),
						});

						log.info(
							{ repo, prNumber, label: label.name },
							"Stored label blocker",
						);
					} else if (payload.action === "unlabeled") {
						await removePRBlocker(prNumber, `label:${label.name}`);

						log.info(
							{ repo, prNumber, label: label.name },
							"Removed label blocker",
						);
					}
				} catch (error) {
					log.error({ err: error }, "Failed to process label event");
				}
			},
		);

		// Handle PR description edits for blocker detection
		app.on("pull_request.edited", async (context) => {
			const { payload } = context;
			const log = webhookLogger.child({ delivery: context.id });

			try {
				// Only process if the body was changed
				if (!payload.changes?.body) {
					return;
				}

				const repo = payload.repository.full_name;
				const prNumber = payload.pull_request.number;
				const body = payload.pull_request.body;

				const descriptionBlocker = parseDescriptionBlockers(body);

				if (descriptionBlocker) {
					await setPRBlocker(prNumber, "description", {
						type: "description",
						description: descriptionBlocker,
						detectedAt: new Date().toISOString(),
					});

					log.info(
						{ repo, prNumber, blocker: descriptionBlocker },
						"Stored description blocker",
					);
				} else {
					// Remove any existing description blocker if section was removed
					await removePRBlocker(prNumber, "description");

					log.debug({ repo, prNumber }, "No description blocker found");
				}
			} catch (error) {
				log.error({ err: error }, "Failed to process PR edit event");
			}
		});

		// Handle review requests for pending review blockers
		app.on(
			["pull_request.review_requested", "pull_request.review_request_removed"],
			async (context) => {
				const { payload } = context;
				const log = webhookLogger.child({ delivery: context.id });

				try {
					const repo = payload.repository.full_name;
					const prNumber = payload.pull_request.number;

					// Handle individual reviewer requests
					const requestedReviewer = payload.requested_reviewer;
					if (requestedReviewer && "login" in requestedReviewer) {
						const reviewer = requestedReviewer.login;

						if (payload.action === "review_requested") {
							await setPRBlocker(prNumber, `pending:${reviewer}`, {
								type: "pending_review",
								description: `Waiting on review from @${reviewer}`,
								reviewer,
								detectedAt: new Date().toISOString(),
							});

							log.info(
								{ repo, prNumber, reviewer },
								"Stored pending review blocker",
							);
						} else if (payload.action === "review_request_removed") {
							await removePRBlocker(prNumber, `pending:${reviewer}`);

							log.info(
								{ repo, prNumber, reviewer },
								"Removed pending review blocker",
							);
						}
					}

					// Handle team review requests
					const requestedTeam = payload.requested_team;
					if (requestedTeam?.slug) {
						const teamSlug = requestedTeam.slug;

						if (payload.action === "review_requested") {
							await setPRBlocker(prNumber, `pending:team:${teamSlug}`, {
								type: "pending_review",
								description: `Waiting on review from team @${teamSlug}`,
								detectedAt: new Date().toISOString(),
							});

							log.info(
								{ repo, prNumber, team: teamSlug },
								"Stored pending team review blocker",
							);
						} else if (payload.action === "review_request_removed") {
							await removePRBlocker(prNumber, `pending:team:${teamSlug}`);

							log.info(
								{ repo, prNumber, team: teamSlug },
								"Removed pending team review blocker",
							);
						}
					}
				} catch (error) {
					log.error({ err: error }, "Failed to process review request event");
				}
			},
		);

		// Log app startup
		app.log.info("Elapse webhook handler loaded");
	};
}

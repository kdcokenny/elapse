/**
 * Probot webhook handler for push events.
 * Filters commits and adds digestion jobs to BullMQ.
 */

import type { Queue } from "bullmq";
import type { Probot } from "probot";
import { type Commit, filterCommits, type Sender } from "./core/filters";
import { webhookLogger } from "./logger";

export interface DigestJob {
	repo: string;
	user: string;
	sha: string;
	message: string;
	installationId: number;
	timestamp: string;
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
					};

					await queue.add("digest", jobData, JOB_OPTIONS);

					log.debug(
						{ repo, sha: commit.id.slice(0, 7), user: jobData.user },
						"Queued commit for digestion",
					);
				}

				log.info(
					{ repo, queued: included.length, filtered: excluded.length },
					"Processed push event",
				);
			} catch (error) {
				// Log but don't throw - webhook must return 200
				log.error({ error }, "Failed to process push event");
			}
		});

		// Log app startup
		app.log.info("Elapse webhook handler loaded");
	};
}

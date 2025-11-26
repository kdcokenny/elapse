/**
 * GitHub webhook handler using @octokit/webhooks web middleware.
 */

import { createWebMiddleware } from "@octokit/webhooks";
import type { Probot } from "probot";

/**
 * Create a webhook handler function that works with Bun.serve().
 * Uses @octokit/webhooks' native web middleware for Web API compatibility.
 */
export function createWebhookHandler(probot: Probot) {
	const webMiddleware = createWebMiddleware(probot.webhooks, {
		path: "/api/github/webhooks",
	});

	return async (req: Request): Promise<Response> => {
		const response = await webMiddleware(req);
		return response;
	};
}

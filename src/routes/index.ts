/**
 * Route aggregation and Bun.serve() server factories.
 */

type BunServer = ReturnType<typeof Bun.serve>;

import type { Probot } from "probot";
import { healthRoute } from "./health";
import { createSetupRoutes } from "./setup";
import { createWebhookHandler } from "./webhooks";

/**
 * Create the main server for normal operation mode.
 */
export function createNormalServer(probot: Probot, port: number): BunServer {
	const webhookHandler = createWebhookHandler(probot);

	return Bun.serve({
		port,
		hostname: "0.0.0.0",
		routes: {
			"/health": { GET: healthRoute },
			"/api/github/webhooks": {
				GET: webhookHandler,
				POST: webhookHandler,
			},
		},
		fetch() {
			return Response.json({ error: "Not Found" }, { status: 404 });
		},
	});
}

/**
 * Create the server for setup mode (GitHub App registration).
 */
export function createSetupServer(port: number): BunServer {
	const routes = createSetupRoutes(port);

	return Bun.serve({
		port,
		hostname: "0.0.0.0",
		routes,
		fetch() {
			return new Response("Not found", { status: 404 });
		},
	});
}

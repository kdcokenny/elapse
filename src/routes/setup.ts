/**
 * Setup mode routes for GitHub App registration.
 */

import { logger } from "../logger";
import {
	exchangeCode,
	generateManifest,
	getSetupPage,
	getSuccessPage,
	writeCredentialsToEnv,
} from "../setup";

/**
 * Extract base URL from request headers (handles proxies).
 */
function getBaseUrl(req: Request, port: number): string {
	const headers = req.headers;
	const proto = headers.get("x-forwarded-proto") || "http";
	const host =
		headers.get("x-forwarded-host") ||
		headers.get("host") ||
		`localhost:${port}`;
	return `${proto}://${host}`;
}

/**
 * Create route handlers for setup mode.
 */
export function createSetupRoutes(port: number) {
	return {
		"/health": Response.json({ status: "setup", mode: "setup" }),

		"/": (req: Request) => {
			const baseUrl = getBaseUrl(req, port);
			const manifest = generateManifest(baseUrl);
			return new Response(getSetupPage(manifest), {
				headers: { "Content-Type": "text/html" },
			});
		},

		"/probot": (req: Request) => {
			const baseUrl = getBaseUrl(req, port);
			const manifest = generateManifest(baseUrl);
			return new Response(getSetupPage(manifest), {
				headers: { "Content-Type": "text/html" },
			});
		},

		"/setup/callback": async (req: Request) => {
			const url = new URL(req.url);
			const code = url.searchParams.get("code");

			if (!code) {
				return new Response("Missing code parameter", { status: 400 });
			}

			try {
				logger.info("Exchanging code for GitHub App credentials...");
				const app = await exchangeCode(code);
				logger.info({ appId: app.id }, "GitHub App created successfully");

				const envWriteSuccess = await writeCredentialsToEnv(app);

				return new Response(getSuccessPage(app, envWriteSuccess), {
					headers: { "Content-Type": "text/html" },
				});
			} catch (err) {
				logger.error({ err }, "Failed to exchange code for credentials");
				return new Response("Failed to create GitHub App. Please try again.", {
					status: 500,
				});
			}
		},
	};
}

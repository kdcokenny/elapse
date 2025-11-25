/**
 * Custom setup server for one-click GitHub App creation.
 * Uses GitHub's manifest flow to create and configure the app automatically.
 */

import { createServer, type Server } from "node:http";
import { logger } from "./logger";
import { storeCredentials } from "./redis";

const GITHUB_API = "https://api.github.com";

interface ManifestResponse {
	id: number;
	pem: string;
	webhook_secret: string;
	html_url: string;
}

/**
 * Extract base URL from request headers (handles proxies).
 */
function getBaseUrl(
	req: { headers: Record<string, string | string[] | undefined> },
	port: number,
): string {
	const proto = req.headers["x-forwarded-proto"] || "http";
	const host =
		req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
	const protocol = Array.isArray(proto) ? proto[0] : proto;
	const hostname = Array.isArray(host) ? host[0] : host;
	return `${protocol}://${hostname}`;
}

/**
 * Generate GitHub App manifest with required permissions.
 */
function generateManifest(baseUrl: string): string {
	return JSON.stringify({
		name: "Elapse",
		url: baseUrl,
		hook_attributes: {
			url: `${baseUrl}/api/github/webhooks`,
		},
		redirect_url: `${baseUrl}/setup/callback`,
		public: false,
		default_permissions: {
			contents: "read",
			metadata: "read",
		},
		default_events: ["push"],
	});
}

/**
 * Exchange the temporary code from GitHub for app credentials.
 */
async function exchangeCode(code: string): Promise<ManifestResponse> {
	const res = await fetch(`${GITHUB_API}/app-manifests/${code}/conversions`, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
		},
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GitHub API error: ${res.status} - ${body}`);
	}

	return res.json() as Promise<ManifestResponse>;
}

/**
 * Generate the setup HTML page.
 */
function getSetupPage(manifest: string): string {
	const createAppUrl = "https://github.com/settings/apps/new";
	const escapedManifest = manifest.replace(/'/g, "&#39;");

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elapse Setup</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #333; }
    p { color: #666; }
    button {
      background: #238636;
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 6px;
      cursor: pointer;
    }
    button:hover { background: #2ea043; }
    .info {
      background: #f6f8fa;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 16px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <h1>Welcome to Elapse</h1>
  <p>Elapse translates your git activity into stakeholder-ready standup updates.</p>

  <div class="info">
    <strong>One-click setup:</strong> Click the button below to create a GitHub App
    with the required permissions. You'll be redirected to GitHub to authorize the app.
  </div>

  <form action="${createAppUrl}" method="post">
    <input type="hidden" name="manifest" value='${escapedManifest}'>
    <button type="submit">Register GitHub App</button>
  </form>
</body>
</html>`;
}

/**
 * Create the setup HTTP server.
 */
export function createSetupServer(
	port: number,
	onComplete: () => void,
): Server {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://localhost:${port}`);
		const baseUrl = getBaseUrl(req, port);

		// Health check
		if (url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "setup", mode: "setup" }));
			return;
		}

		// Setup page with register button
		if (url.pathname === "/" || url.pathname === "/probot") {
			const manifest = generateManifest(baseUrl);
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(getSetupPage(manifest));
			return;
		}

		// Callback from GitHub after app creation
		if (url.pathname === "/setup/callback") {
			const code = url.searchParams.get("code");

			if (!code) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Missing code parameter");
				return;
			}

			try {
				logger.info("Exchanging code for GitHub App credentials...");
				const app = await exchangeCode(code);

				await storeCredentials({
					appId: String(app.id),
					privateKey: app.pem,
					webhookSecret: app.webhook_secret,
				});

				logger.info(
					{ appId: app.id },
					"GitHub App created and credentials saved to Redis",
				);

				// Redirect user to install the app on their repos
				res.writeHead(302, { Location: `${app.html_url}/installations/new` });
				res.end();

				// Trigger restart after a short delay to let the redirect complete
				setTimeout(() => {
					logger.info("Setup complete. Restarting to apply credentials...");
					onComplete();
				}, 2000);
			} catch (err) {
				logger.error({ err }, "Failed to exchange code for credentials");
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Failed to create GitHub App. Please try again.");
			}
			return;
		}

		// 404 for everything else
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	});

	return server;
}

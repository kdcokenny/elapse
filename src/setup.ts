/**
 * Custom setup server for one-click GitHub App creation.
 * Uses GitHub's manifest flow to create and configure the app automatically.
 */

import { appendFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { logger } from "./logger";

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
 * Generate .env content for credentials.
 */
function generateEnvContent(app: ManifestResponse): string {
	return `
# Elapse GitHub App Credentials (auto-generated)
APP_ID=${app.id}
WEBHOOK_SECRET=${app.webhook_secret}
PRIVATE_KEY="${app.pem}"
`;
}

/**
 * Write credentials to .env file (append).
 * Returns true on success, false on failure.
 */
async function writeCredentialsToEnv(app: ManifestResponse): Promise<boolean> {
	try {
		const envPath = join(process.cwd(), ".env");
		const content = generateEnvContent(app);
		await appendFile(envPath, content);
		logger.info({ envPath }, "Credentials appended to .env");
		return true;
	} catch (err) {
		logger.error({ err }, "Failed to write credentials to .env");
		return false;
	}
}

/**
 * Exchange the temporary code from GitHub for app credentials.
 * In dev mode, returns mock credentials for UI testing.
 */
async function exchangeCode(code: string): Promise<ManifestResponse> {
	// Dev mode: return mock credentials for UI testing
	if (process.env.NODE_ENV === "development") {
		return {
			id: 123456,
			pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy...\n(sample private key for development testing)\n-----END RSA PRIVATE KEY-----",
			webhook_secret: "dev_webhook_secret_abc123",
			html_url: "https://github.com/apps/elapse-dev",
		};
	}

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
	const isDev = process.env.NODE_ENV === "development";

	const devLink = isDev
		? `<a href="/setup/callback?code=dev" class="block mt-6 text-sm text-gray-500 hover:text-gray-700">Skip to preview (dev only)</a>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elapse Setup</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="max-w-xl mx-auto px-6 py-16">
    <h1 class="text-3xl font-bold text-gray-900 mb-3">Welcome to Elapse</h1>
    <p class="text-gray-600 mb-8">Elapse translates your git activity into stakeholder-ready standup updates.</p>

    <div class="bg-white border border-gray-200 rounded-lg p-5 mb-8">
      <p class="text-gray-700">
        <span class="font-semibold">One-click setup:</span> Click the button below to create a GitHub App
        with the required permissions. You'll be redirected to GitHub to authorize the app.
      </p>
    </div>

    <form action="${createAppUrl}" method="post">
      <input type="hidden" name="manifest" value='${escapedManifest}'>
      <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-3 px-6 rounded-lg transition-colors">
        Register GitHub App
      </button>
    </form>
    ${devLink}
  </div>
</body>
</html>`;
}

/**
 * Generate the success page after credentials are saved to .env.
 * Shows confirmation, View toggle for credentials, and install button.
 */
function getSuccessPage(
	app: ManifestResponse,
	envWriteSuccess: boolean,
): string {
	const envContent = generateEnvContent(app).trim();

	// Escape for HTML textarea
	const escapedEnvContent = envContent
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// For JS string (escape backticks and backslashes)
	const jsEnvContent = envContent.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

	const statusMessage = envWriteSuccess
		? `<span class="text-green-700">Credentials saved to .env</span>`
		: `<span class="text-amber-700">Could not write to .env - copy credentials below</span>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elapse - Setup Complete</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="max-w-2xl mx-auto px-6 py-16">
    <!-- Success header -->
    <div class="flex items-center gap-3 mb-3">
      <div class="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
        <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
        </svg>
      </div>
      <h1 class="text-2xl font-bold text-gray-900">GitHub App Created!</h1>
    </div>

    <!-- Credentials status with View toggle -->
    <div class="bg-white border border-gray-200 rounded-lg p-4 mb-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 ${envWriteSuccess ? "text-green-600" : "text-amber-600"}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${envWriteSuccess ? "M5 13l4 4L19 7" : "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"}"></path>
          </svg>
          ${statusMessage}
        </div>
        <button id="view-toggle" onclick="toggleCredentials()" class="text-sm text-blue-600 hover:text-blue-800 font-medium">${envWriteSuccess ? "View" : "Hide"}</button>
      </div>

      <!-- Collapsible credentials textarea -->
      <div id="credentials-section" class="${envWriteSuccess ? "hidden" : ""} mt-4">
        <textarea readonly class="w-full font-mono text-xs p-3 bg-gray-50 border border-gray-200 rounded-lg h-40 resize-none">${escapedEnvContent}</textarea>
        <button onclick="copyCredentials()" id="copy-btn" class="mt-2 text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
          </svg>
          <span id="copy-text">Copy to clipboard</span>
        </button>
      </div>
    </div>

    <!-- Next steps -->
    <div class="bg-gray-50 border border-gray-200 rounded-lg p-5 mb-6">
      <h2 class="font-semibold text-gray-900 mb-3">Next Steps</h2>
      <ol class="space-y-3">
        <li class="flex items-start gap-3">
          <span class="flex-shrink-0 w-6 h-6 bg-green-600 text-white rounded-full flex items-center justify-center text-sm font-medium">1</span>
          <div>
            <span class="font-medium text-gray-900">Install the app on your repositories</span>
            <p class="text-sm text-gray-600">Select which repos Elapse should monitor</p>
          </div>
        </li>
        <li class="flex items-start gap-3">
          <span class="flex-shrink-0 w-6 h-6 bg-gray-300 text-gray-700 rounded-full flex items-center justify-center text-sm font-medium">2</span>
          <div>
            <span class="font-medium text-gray-900">Restart your server</span>
            <p class="text-sm text-gray-600">The new credentials will be loaded on restart</p>
          </div>
        </li>
      </ol>
    </div>

    <!-- Primary action: Install app -->
    <a href="${app.html_url}/installations/new" target="_blank" class="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-4 px-6 rounded-lg transition-colors flex items-center justify-center gap-2">
      Install App on Repositories
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
      </svg>
    </a>
  </div>

  <script>
    const envContent = \`${jsEnvContent}\`;

    function toggleCredentials() {
      const section = document.getElementById('credentials-section');
      const toggle = document.getElementById('view-toggle');
      const isHidden = section.classList.contains('hidden');

      if (isHidden) {
        section.classList.remove('hidden');
        toggle.textContent = 'Hide';
      } else {
        section.classList.add('hidden');
        toggle.textContent = 'View';
      }
    }

    function copyCredentials() {
      navigator.clipboard.writeText(envContent).then(() => {
        const copyText = document.getElementById('copy-text');
        copyText.textContent = 'Copied!';
        setTimeout(() => {
          copyText.textContent = 'Copy to clipboard';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Create the setup HTTP server.
 */
export function createSetupServer(port: number): Server {
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

				logger.info({ appId: app.id }, "GitHub App created successfully");

				// Write credentials to .env
				const envWriteSuccess = await writeCredentialsToEnv(app);

				// Show success page
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(getSuccessPage(app, envWriteSuccess));
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

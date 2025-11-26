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
 * Uses new GITHUB_ prefixed variable names.
 */
function generateEnvContent(app: ManifestResponse): string {
	return `
# Elapse GitHub App Credentials (auto-generated)
GITHUB_APP_ID=${app.id}
GITHUB_WEBHOOK_SECRET=${app.webhook_secret}
GITHUB_APP_PRIVATE_KEY="${app.pem}"
`;
}

/**
 * Generate base64-encoded private key for Docker environments.
 */
function generateBase64Key(pem: string): string {
	return Buffer.from(pem).toString("base64");
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
 * Shows confirmation, View toggle for credentials, base64 key for Docker, and install button.
 */
function getSuccessPage(
	app: ManifestResponse,
	envWriteSuccess: boolean,
): string {
	const envContent = generateEnvContent(app).trim();
	const base64Key = generateBase64Key(app.pem);

	// Escape for HTML textarea
	const escapedEnvContent = envContent
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// For JS string (escape backticks and backslashes)
	const jsEnvContent = envContent.replace(/\\/g, "\\\\").replace(/`/g, "\\`");

	const statusMessage = envWriteSuccess
		? `<span class="text-green-700">Credentials saved to .env</span>`
		: `<span class="text-blue-700">Copy credentials below to your environment</span>`;

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

    <!-- Docker/Dokploy: Base64 credentials (recommended) -->
    <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
      <div class="flex items-center gap-2 mb-3">
        <svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"></path>
        </svg>
        <span class="font-semibold text-blue-900">For Docker / Dokploy</span>
      </div>
      <p class="text-sm text-blue-800 mb-3">Copy these values to your environment variables:</p>
      <div class="space-y-2 font-mono text-xs">
        <div class="flex items-center gap-2">
          <code class="bg-blue-100 px-2 py-1 rounded">GITHUB_APP_ID</code>
          <code class="bg-white border border-blue-200 px-2 py-1 rounded flex-1 truncate">${app.id}</code>
          <button onclick="copyToClipboard('${app.id}', this)" class="text-blue-600 hover:text-blue-800 text-xs">Copy</button>
        </div>
        <div class="flex items-center gap-2">
          <code class="bg-blue-100 px-2 py-1 rounded">GITHUB_WEBHOOK_SECRET</code>
          <code class="bg-white border border-blue-200 px-2 py-1 rounded flex-1 truncate">${app.webhook_secret}</code>
          <button onclick="copyToClipboard('${app.webhook_secret}', this)" class="text-blue-600 hover:text-blue-800 text-xs">Copy</button>
        </div>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <code class="bg-blue-100 px-2 py-1 rounded">GITHUB_APP_PRIVATE_KEY</code>
            <span class="text-blue-600 text-xs">(base64 encoded)</span>
            <button onclick="copyToClipboard(base64Key, this)" class="text-blue-600 hover:text-blue-800 text-xs ml-auto">Copy</button>
          </div>
          <textarea readonly class="w-full bg-white border border-blue-200 rounded p-2 h-16 resize-none text-xs">${base64Key}</textarea>
        </div>
      </div>
    </div>

    <!-- Credentials status with View toggle -->
    <div class="bg-white border border-gray-200 rounded-lg p-4 mb-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 ${envWriteSuccess ? "text-green-600" : "text-blue-600"}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${envWriteSuccess ? "M5 13l4 4L19 7" : "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"}"></path>
          </svg>
          ${statusMessage}
        </div>
        <button id="view-toggle" onclick="toggleCredentials()" class="text-sm text-blue-600 hover:text-blue-800 font-medium">View raw</button>
      </div>

      <!-- Collapsible raw credentials textarea -->
      <div id="credentials-section" class="hidden mt-4">
        <p class="text-xs text-gray-500 mb-2">Raw .env format (for local development):</p>
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
    const base64Key = \`${base64Key}\`;

    function toggleCredentials() {
      const section = document.getElementById('credentials-section');
      const toggle = document.getElementById('view-toggle');
      const isHidden = section.classList.contains('hidden');

      if (isHidden) {
        section.classList.remove('hidden');
        toggle.textContent = 'Hide raw';
      } else {
        section.classList.add('hidden');
        toggle.textContent = 'View raw';
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

    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
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

				// Try to write credentials - if it fails, user can copy from UI
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

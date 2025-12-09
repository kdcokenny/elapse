/**
 * Elapse Doctor - Setup verification command.
 * Checks that all required components are properly configured.
 *
 * Run: bun run doctor
 */

import { createInterface } from "node:readline";
import { google } from "@ai-sdk/google";
import { createAppAuth } from "@octokit/auth-app";
import { generateText } from "ai";
import Redis from "ioredis";
import { DEFAULT_REDIS_URL } from "./config";
import { getCredentials } from "./credentials";

// =============================================================================
// Types
// =============================================================================

type CheckStatus = "pass" | "fail" | "warn" | "info";

interface CheckResult {
	name: string;
	status: CheckStatus;
	message: string;
	details?: string[];
}

// Status icons
const ICONS: Record<CheckStatus, string> = {
	pass: "[✓]",
	fail: "[✗]",
	warn: "[!]",
	info: "[i]",
};

// =============================================================================
// Interactive Input
// =============================================================================

/**
 * Prompt the user for input via readline.
 */
function prompt(question: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

// =============================================================================
// Check Functions
// =============================================================================

/**
 * Check Redis connectivity by sending PING.
 */
async function checkRedis(): Promise<CheckResult> {
	const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;

	try {
		const client = new Redis(redisUrl, {
			maxRetriesPerRequest: 1,
			connectTimeout: 5000,
			lazyConnect: true,
		});

		await client.connect();
		const pong = await client.ping();
		await client.quit();

		if (pong === "PONG") {
			return {
				name: "Redis connection",
				status: "pass",
				message: `Connected to ${redisUrl}`,
			};
		}

		return {
			name: "Redis connection",
			status: "fail",
			message: `Unexpected PING response: ${pong}`,
		};
	} catch (error) {
		return {
			name: "Redis connection",
			status: "fail",
			message: "Cannot connect to Redis",
			details: [
				`URL: ${redisUrl}`,
				`Error: ${(error as Error).message}`,
				"",
				"Hint: Ensure Redis is running or set REDIS_URL",
			],
		};
	}
}

/**
 * Check AI configuration and test API connectivity.
 */
async function checkAIConfig(): Promise<CheckResult> {
	const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
	const modelName = process.env.LLM_MODEL_NAME;

	// Check env vars first
	if (!apiKey) {
		return {
			name: "Google Gemini AI",
			status: "fail",
			message: "Missing GOOGLE_GENERATIVE_AI_API_KEY",
			details: ["Get API key from: https://aistudio.google.com/app/apikey"],
		};
	}

	if (!modelName) {
		return {
			name: "Google Gemini AI",
			status: "fail",
			message: "Missing LLM_MODEL_NAME",
			details: ["Set LLM_MODEL_NAME (e.g., gemini-2.0-flash)"],
		};
	}

	// Test API connectivity
	try {
		const model = google(modelName);
		await generateText({
			model,
			prompt: "Reply with only: OK",
		});

		return {
			name: "Google Gemini AI",
			status: "pass",
			message: "API connected",
			details: [`API key: ${apiKey.slice(0, 8)}...`, `Model: ${modelName}`],
		};
	} catch (error) {
		return {
			name: "Google Gemini AI",
			status: "fail",
			message: "API test failed",
			details: [
				`API key: ${apiKey.slice(0, 8)}...`,
				`Model: ${modelName}`,
				`Error: ${(error as Error).message}`,
			],
		};
	}
}

/**
 * Check Discord webhook with OTP verification.
 */
async function checkDiscord(): Promise<CheckResult> {
	const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

	// Not configured - just a warning
	if (!webhookUrl) {
		return {
			name: "Discord webhook",
			status: "warn",
			message: "Not configured - reports will log to console",
			details: ["Set DISCORD_WEBHOOK_URL to enable Discord delivery"],
		};
	}

	// Validate URL format
	if (!webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
		return {
			name: "Discord webhook",
			status: "fail",
			message: "Invalid webhook URL format",
			details: ["URL should start with: https://discord.com/api/webhooks/"],
		};
	}

	// Generate OTP code
	const code = Math.floor(100000 + Math.random() * 900000).toString();

	// Send verification message
	console.log("    Sending verification code to Discord...");

	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: `🔐 **Elapse verification code:** \`${code}\`\n\n_This is a test message from \`bun run doctor\`. You can delete this message._`,
			}),
		});

		if (!response.ok) {
			const status = response.status;
			if (status === 401) {
				return {
					name: "Discord webhook",
					status: "fail",
					message: "Invalid webhook token",
				};
			}
			if (status === 404) {
				return {
					name: "Discord webhook",
					status: "fail",
					message: "Webhook not found (deleted?)",
				};
			}
			return {
				name: "Discord webhook",
				status: "fail",
				message: `Webhook request failed: HTTP ${status}`,
			};
		}
	} catch (error) {
		return {
			name: "Discord webhook",
			status: "fail",
			message: "Failed to send message",
			details: [`Error: ${(error as Error).message}`],
		};
	}

	// Prompt for code verification
	const entered = await prompt("    Enter the code you see in Discord: ");

	if (entered === code) {
		return {
			name: "Discord webhook",
			status: "pass",
			message: "Webhook verified!",
		};
	}

	return {
		name: "Discord webhook",
		status: "fail",
		message: "Code mismatch - verification failed",
		details: [`Expected: ${code}`, `Entered: ${entered}`],
	};
}

/**
 * Check GitHub App credentials and JWT generation.
 */
async function checkGitHubApp(): Promise<CheckResult> {
	const credentials = getCredentials();

	// Not configured - info only (setup wizard available)
	if (!credentials) {
		return {
			name: "GitHub App credentials",
			status: "info",
			message: "Not configured - will use setup wizard",
			details: ["Visit http://localhost:3000 after starting to configure"],
		};
	}

	// Test JWT generation
	try {
		const auth = createAppAuth({
			appId: credentials.appId,
			privateKey: credentials.privateKey,
		});

		await auth({ type: "app" });

		const details = [`App ID: ${credentials.appId}`, "Private key: valid"];

		if (credentials.webhookSecret) {
			details.push("Webhook secret: configured");
		} else {
			details.push("Webhook secret: not set (optional)");
		}

		return {
			name: "GitHub App credentials",
			status: "pass",
			message: "Credentials valid",
			details,
		};
	} catch (error) {
		return {
			name: "GitHub App credentials",
			status: "fail",
			message: "JWT generation failed",
			details: [
				`App ID: ${credentials.appId}`,
				`Error: ${(error as Error).message}`,
				"",
				"Hint: Check that your private key matches your App ID",
			],
		};
	}
}

// =============================================================================
// Output Helpers
// =============================================================================

/**
 * Print a single check result.
 */
function printResult(result: CheckResult): void {
	const icon = ICONS[result.status];
	console.log(`${icon} ${result.name}`);
	console.log(`    ${result.message}`);

	if (result.details) {
		for (const line of result.details) {
			console.log(`    ${line}`);
		}
	}
	console.log();
}

/**
 * Print summary of all results.
 */
function printSummary(results: CheckResult[]): void {
	const counts = {
		pass: results.filter((r) => r.status === "pass").length,
		fail: results.filter((r) => r.status === "fail").length,
		warn: results.filter((r) => r.status === "warn").length,
		info: results.filter((r) => r.status === "info").length,
	};

	console.log("---");

	const parts: string[] = [];
	if (counts.pass > 0) parts.push(`${counts.pass} passed`);
	if (counts.fail > 0) parts.push(`${counts.fail} failed`);
	if (counts.warn > 0)
		parts.push(`${counts.warn} warning${counts.warn > 1 ? "s" : ""}`);
	if (counts.info > 0) parts.push(`${counts.info} info`);

	console.log(parts.join(", "));
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
	console.log("Elapse Doctor");
	console.log("=============\n");

	// Run checks sequentially (Discord needs interactive input)
	const redisResult = await checkRedis();
	printResult(redisResult);

	const aiResult = await checkAIConfig();
	printResult(aiResult);

	// Discord check includes interactive prompt
	console.log(`${ICONS.info} Discord webhook`);
	const discordResult = await checkDiscord();
	// Re-print with actual result (overwrite the placeholder)
	process.stdout.write("\x1B[2A\x1B[0J"); // Move up 2 lines and clear
	printResult(discordResult);

	const githubResult = await checkGitHubApp();
	printResult(githubResult);

	const results = [redisResult, aiResult, discordResult, githubResult];
	printSummary(results);

	// Exit with error if any failures
	const hasFail = results.some((r) => r.status === "fail");
	process.exit(hasFail ? 1 : 0);
}

main().catch((error) => {
	console.error("Doctor command failed:", error);
	process.exit(1);
});

/**
 * Shared credential helpers for GitHub App authentication.
 * Uses @probot/get-private-key for auto-detection of key formats
 * (base64, \n-escaped, or plain PEM).
 */

import { getPrivateKey as getProbotPrivateKey } from "@probot/get-private-key";

export interface Credentials {
	appId: string;
	privateKey: string;
	webhookSecret: string;
}

/**
 * Get the GitHub App private key from environment variables.
 * Supports multiple formats via Probot's auto-detection:
 * - Plain PEM (multiline)
 * - Base64-encoded PEM (single line, for Docker)
 * - \n-escaped PEM (literal \n strings)
 */
export function getPrivateKey(): string | null {
	const key = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!key) return null;

	// Use Probot's package for auto-detection
	return (
		getProbotPrivateKey({
			env: { PRIVATE_KEY: key },
		}) ?? null
	);
}

/**
 * Get all GitHub App credentials from environment variables.
 */
export function getCredentials(): Credentials | null {
	const appId = process.env.GITHUB_APP_ID;
	const privateKey = getPrivateKey();

	if (appId && privateKey) {
		return {
			appId,
			privateKey,
			webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
		};
	}
	return null;
}

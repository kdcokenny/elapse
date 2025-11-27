/**
 * Pure functions for building AI prompts.
 * These are separated for easy testing and prompt engineering.
 */

import { isVagueMessage } from "./filters";

const MAX_DIFF_SIZE = 8000; // Characters to send to AI

/**
 * Truncate a diff to a reasonable size for AI processing.
 */
export function truncateDiff(diff: string): {
	truncated: string;
	wasTruncated: boolean;
	originalSize: number;
} {
	const originalSize = diff.length;

	if (diff.length <= MAX_DIFF_SIZE) {
		return { truncated: diff, wasTruncated: false, originalSize };
	}

	const truncated = `${diff.slice(0, MAX_DIFF_SIZE)}\n\n[... diff truncated ...]`;
	return { truncated, wasTruncated: true, originalSize };
}

/**
 * Build the system prompt for the translator (diff → structured summary).
 */
export function buildTranslatorSystemPrompt(projectContext?: string): string {
	const context = projectContext || "a software project";

	return `You are a technical writer who translates git commits into structured summaries for stakeholders.

Context: You are writing updates for ${context}.

For each commit, determine:
1. action: "include" for meaningful changes, "skip" for trivial changes
2. summary: Business-value sentence (max 20 words, past tense, active voice)
3. category: One of feature, fix, improvement, refactor, docs, chore
4. significance: high (user-facing), medium (internal), low (minor)

Rules:
- Focus on BUSINESS VALUE, not technical implementation
- Don't mention file names, function names, or technical jargon
- Use SKIP for: typos, formatting, whitespace, comments, import reordering

Examples:
- feature/high: "Added user authentication so customers can securely access their accounts"
- fix/high: "Fixed a bug that was causing checkout failures for some users"
- improvement/medium: "Improved page load performance by optimizing database queries"
- refactor/low: "Reorganized code for better maintainability"`;
}

/**
 * Build the user prompt for the translator.
 */
export function buildTranslatorUserPrompt(
	message: string,
	diff: string,
): string {
	const { truncated, wasTruncated } = truncateDiff(diff);
	const isVague = isVagueMessage(message);

	let prompt = "";

	if (isVague) {
		prompt += `Note: The commit message is vague ("${message}"), so focus primarily on the diff to understand what changed.\n\n`;
	} else {
		prompt += `Commit message: ${message}\n\n`;
	}

	prompt += `Diff:\n\`\`\`\n${truncated}\n\`\`\``;

	if (wasTruncated) {
		prompt +=
			"\n\n(Note: The diff was truncated. Summarize based on what you can see.)";
	}

	return prompt;
}

/**
 * Build the complete translator prompt object.
 */
export function buildTranslatorPrompt(
	message: string,
	diff: string,
	projectContext?: string,
): { system: string; user: string } {
	return {
		system: buildTranslatorSystemPrompt(projectContext),
		user: buildTranslatorUserPrompt(message, diff),
	};
}

/**
 * Build the system prompt for comment blocker analysis.
 */
export function buildCommentAnalysisSystemPrompt(): string {
	return `You analyze PR comments to determine if they indicate a blocker or resolve one.

A BLOCKER is something preventing the PR from being merged or work from progressing:
- External dependencies ("waiting on API from team X", "blocked by #123")
- Review concerns ("needs security review", "architecture decision needed")
- Technical issues ("CI failing", "tests broken", "need to fix X first")
- Resource blockers ("need access to prod", "waiting for credentials")
- Questions that must be answered before proceeding

A RESOLUTION is when a previously mentioned blocker is addressed:
- "Fixed", "Resolved", "Done", "Addressed"
- "No longer blocked", "Got access", "This is ready now"
- Approval or confirmation language
- Answers to blocking questions

Important:
- Most comments are NOT blockers (discussions, reviews, suggestions)
- Only flag clear blocking statements, not minor concerns
- When in doubt, use action "none"
- Description should be brief (max 15 words), only for add_blocker`;
}

/**
 * Build the user prompt for comment blocker analysis.
 */
export function buildCommentAnalysisUserPrompt(
	prTitle: string,
	prNumber: number,
	commentBody: string,
): string {
	return `PR #${prNumber}: "${prTitle}"

Comment:
${commentBody}`;
}

/**
 * Build the complete comment analysis prompt object.
 */
export function buildCommentAnalysisPrompt(
	prTitle: string,
	prNumber: number,
	commentBody: string,
): { system: string; user: string } {
	return {
		system: buildCommentAnalysisSystemPrompt(),
		user: buildCommentAnalysisUserPrompt(prTitle, prNumber, commentBody),
	};
}

// =============================================================================
// Feature Narrator Prompts (PR → Feature Summary)
// =============================================================================

/**
 * Build the system prompt for feature-level narration.
 * Converts PR translations into a human-readable feature name and impact.
 */
export function buildFeatureNarratorSystemPrompt(
	projectContext?: string,
): string {
	const context = projectContext || "a software project";

	return `You are a technical writer creating feature summaries for stakeholders.

Context: You are writing about ${context}.

Given a PR title and list of commit translations, generate:
1. featureName: Human-readable headline (max 8 words, action-oriented)
2. impact: Business value statement (max 20 words)

Rules:
- Feature name: "Improved X", "Added Y", "Fixed Z" format
- Impact explains WHY this matters to users/business
- No technical jargon (API, database, refactor) unless essential
- Focus on outcomes, not implementation

Examples:
- featureName: "Improved checkout experience", impact: "Reduced cart abandonment by simplifying the payment flow"
- featureName: "Added team collaboration features", impact: "Teams can now share projects and work together in real-time"
- featureName: "Fixed login issues for mobile users", impact: "Mobile users can now reliably access their accounts"`;
}

/**
 * Build the user prompt for feature-level narration.
 */
export function buildFeatureNarratorUserPrompt(
	prTitle: string,
	prNumber: number,
	translations: string[],
): string {
	if (translations.length === 0) {
		return `PR #${prNumber}: "${prTitle}"\n\nNo meaningful commits.`;
	}

	const numbered = translations.map((t, i) => `${i + 1}. ${t}`).join("\n");

	return `PR #${prNumber}: "${prTitle}"

Commits:
${numbered}`;
}

/**
 * Build the complete feature narrator prompt object.
 */
export function buildFeatureNarratorPrompt(
	prTitle: string,
	prNumber: number,
	translations: string[],
	projectContext?: string,
): { system: string; user: string } {
	return {
		system: buildFeatureNarratorSystemPrompt(projectContext),
		user: buildFeatureNarratorUserPrompt(prTitle, prNumber, translations),
	};
}

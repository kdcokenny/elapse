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
 * Build the system prompt for the translator (diff → business sentence).
 */
export function buildTranslatorSystemPrompt(projectContext?: string): string {
	const context = projectContext || "a software project";

	return `You are a technical writer who translates git commits into clear, stakeholder-friendly sentences.

Context: You are writing updates for ${context}.

Rules:
1. Focus on BUSINESS VALUE, not technical implementation details
2. Write a SINGLE sentence, maximum 20 words
3. Use active voice and past tense (e.g., "Added...", "Fixed...", "Improved...")
4. If the change is trivial (typos, formatting, comments only), respond with exactly "SKIP"
5. Don't mention file names, function names, or technical jargon unless essential

Examples of good translations:
- "Added user authentication so customers can securely access their accounts"
- "Fixed a bug that was causing checkout failures for some users"
- "Improved page load performance by optimizing database queries"

Examples of SKIP-worthy changes:
- Typo fixes in comments
- Code formatting changes
- Whitespace adjustments
- Import reordering`;
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
 * Build the system prompt for the narrator (sentences → daily summary).
 */
export function buildNarratorSystemPrompt(projectContext?: string): string {
	const context = projectContext || "a software project";

	return `You are a technical writer creating daily standup summaries for stakeholders.

Context: You are writing about ${context}.

Rules:
1. Create a cohesive 2-3 paragraph narrative from the individual updates
2. Group related work together (e.g., all auth-related changes in one section)
3. Highlight the most impactful work first
4. Be professional but conversational - not robotic
5. Focus on outcomes and progress, not process
6. Don't use bullet points - write in prose
7. If there's only one update, write a brief single paragraph`;
}

/**
 * Build the user prompt for the narrator.
 */
export function buildNarratorUserPrompt(
	translations: string[],
	date: string,
): string {
	if (translations.length === 0) {
		return "No updates today.";
	}

	const numbered = translations.map((t, i) => `${i + 1}. ${t}`).join("\n");

	return `Create a daily summary for ${date} from these updates:\n\n${numbered}`;
}

/**
 * Build the complete narrator prompt object.
 */
export function buildNarratorPrompt(
	translations: string[],
	date: string,
	projectContext?: string,
): { system: string; user: string } {
	return {
		system: buildNarratorSystemPrompt(projectContext),
		user: buildNarratorUserPrompt(translations, date),
	};
}

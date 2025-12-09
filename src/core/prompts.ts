/**
 * Pure functions for building AI prompts.
 * These are separated for easy testing and prompt engineering.
 */

import { isVagueMessage } from "./filters";

const MAX_DIFF_SIZE = 256000; // ~64K tokens, generous for 1M context window

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
function buildTranslatorSystemPrompt(projectContext?: string): string {
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

HANDLING CONTRADICTORY SIGNALS:

When commit messages contain conflicting information:

1. PRIORITY ORDER: Title > Branch name > Diff > Body
   - PR titles are usually accurate summaries
   - PR bodies often contain context/discussion that contradicts the action

2. DESCRIBE THE RESULT, NOT THE JOURNEY:
   - Bad: "Re-enabled legacy mode for compatibility"
   - Good: "Updated tests to work without legacy mode"

3. FLAG/TOGGLE CHANGES:
   - Focus on the NEW state after the change
   - "disable X" = X is now OFF
   - "enable X" = X is now ON
   - Ignore discussion about why the old state existed

4. NEGATIVE PREFIXES (disable, remove, un-, deprecate):
   - These indicate REMOVAL of capability
   - Don't invert meaning based on body text discussing the removed feature

Examples:
- feature/high: "Added user authentication so customers can securely access their accounts"
- fix/high: "Fixed a bug that was causing checkout failures for some users"
- improvement/medium: "Improved page load performance by optimizing database queries"
- refactor/low: "Reorganized code for better maintainability"`;
}

/**
 * Build the user prompt for the translator.
 */
function buildTranslatorUserPrompt(message: string, diff: string): string {
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
function buildCommentAnalysisSystemPrompt(): string {
	return `You analyze PR comments to determine if they indicate a blocker or resolve one.

A BLOCKER is something preventing the PR from being merged or work from progressing:
- External dependencies ("waiting on API from team X", "blocked by #123")
- Review concerns ("needs security review", "architecture decision needed")
- Technical issues ("CI failing", "tests broken", "need to fix X first")
- Resource blockers ("need access to prod", "waiting for credentials")
- Questions that must be answered before proceeding

BLOCKER EXTRACTION WITH @MENTIONS:
When analyzing comments, extract @mentioned usernames who are being waited on:

1. EXPLICIT @MENTIONS WITH BLOCKING LANGUAGE
   Look for patterns like:
   - "waiting on @username"
   - "blocked by @username"
   - "need @username to review/approve/sign-off"
   - "pending @username"
   - "need @username's input/approval"

   Extract usernames (without @) into mentionedUsers array.
   Description: "Waiting on @username for [action]"

2. EXTERNAL DEPENDENCIES (no @mention)
   Look for patterns like:
   - "waiting for API keys"
   - "blocked on [external team/resource]"
   - "need approval from [department]"
   - "pending legal/security/design review"

   Description: "Blocked on [dependency]"
   mentionedUsers: [] (empty)

3. HELP REQUESTS
   Look for patterns like:
   - "need help with"
   - "stuck on"
   - "can't figure out"

   Description: "Needs help: [brief description]"

A RESOLUTION is when a previously mentioned blocker is addressed:
- "Fixed", "Resolved", "Done", "Addressed"
- "No longer blocked", "Got access", "This is ready now"
- Approval or confirmation language
- Answers to blocking questions

Important:
- Most comments are NOT blockers (discussions, reviews, suggestions)
- Only flag clear blocking statements, not minor concerns
- Do not flag normal review requests as blockers
- When in doubt, use action "none"
- Description should be brief (max 15 words), only for add_blocker
- mentionedUsers: Array of usernames being waited on (without @ symbol), empty if none`;
}

/**
 * Build the user prompt for comment blocker analysis.
 */
function buildCommentAnalysisUserPrompt(
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
function buildFeatureNarratorSystemPrompt(projectContext?: string): string {
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
function buildFeatureNarratorUserPrompt(
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

// =============================================================================
// Weekly Summary Prompts
// =============================================================================

/**
 * Options for conditional section inclusion in weekly prompts.
 *
 * DESIGN: Status sections vs Content sections
 * - Blockers & Risks: STATUS - always shown ("None active" is meaningful)
 * - Help Needed: STATUS - always shown ("(none)" confirms no escalations needed)
 * - Next Week: CONTENT - only shown when we have in-progress data (omit if no data)
 *
 * This prevents hallucination for content sections while keeping status sections
 * visible so executives can quickly confirm "all clear" vs incomplete report.
 */
export interface WeeklyPromptOptions {
	/** Only affects whether we include in-progress data in the prompt */
	includeNextWeek: boolean;
}

/**
 * Build the system prompt for weekly summarization.
 * Status sections (Blockers, Help Needed) are always included.
 * Content sections (Next Week) are conditionally included based on data.
 */
function buildWeeklySummarySystemPrompt(
	projectContext?: string,
	options?: WeeklyPromptOptions,
): string {
	const context = projectContext || "a software project";
	const opts = options || { includeNextWeek: true };

	// Build output sections - status sections always included
	const sections: string[] = [
		`1. EXECUTIVE SUMMARY (exactly 1-2 sentences)
   - Summarize the week's main outcomes
   - Focus on business value, not technical details
   - Be specific: "Shipped payments integration" not "Made progress"`,

		`2. SHIPPED THIS WEEK (3-5 themed groups)
   - Group related PRs by business area (Auth, Payments, Infrastructure, Performance, etc.)
   - Each group: 1-2 sentence summary describing the VALUE delivered
   - Include contributor names in the contributors array
   - Do NOT list individual PRs or PR numbers
   - Do NOT use technical jargon (no "refactored", "migrated", "deprecated")`,

		`3. BLOCKERS & RISKS (STATUS SECTION)
   - If active blockers exist: summarize them with how long blocked
   - If NO active blockers: return null for this field`,

		`4. HELP NEEDED (STATUS SECTION)
   - If escalations needed: extract from blockers, include @mentions
   - If NO escalations needed: return null for this field`,
	];

	// Only include Next Week if we have in-progress data
	if (opts.includeNextWeek) {
		sections.push(`5. CARRYING INTO NEXT WEEK
   - What's in progress that will continue
   - Expected timeline if known
   - Keep to 1-2 items max`);
	}

	const exclusionNote = !opts.includeNextWeek
		? `\n\nIMPORTANT: Do NOT include any "next week" or "carrying into next week" content. There is no in-progress work to report.`
		: "";

	return `You are summarizing a week of engineering activity for non-technical stakeholders.

Your output will be read by engineering managers, product managers, and executives who need to understand what the engineering team accomplished without technical jargon.

Context: You are writing about ${context}.

OUTPUT REQUIREMENTS:

${sections.join("\n\n")}

CONSTRAINTS:
- Total output MUST be under 500 words
- Use plain language a CEO would understand
- No PR numbers in any text
- Each "Shipped" group should be 1-2 sentences max${exclusionNote}`;
}

/**
 * Build the user prompt for weekly summarization.
 * Always includes blocker data (status sections).
 * Only includes in-progress data if we have it (content section).
 */
function buildWeeklySummaryUserPrompt(
	shipped: Array<{ translation: string; author: string }>,
	activeBlockers: Array<{
		reason: string;
		ageDays: number;
		author: string;
		mentionedUsers: string[];
	}>,
	resolvedBlockers: Array<{ reason: string }>,
	inProgress: Array<{ translation: string; author: string }>,
	options?: WeeklyPromptOptions,
): string {
	const opts = options || { includeNextWeek: true };

	const shippedList =
		shipped.length === 0
			? "(none)"
			: shipped.map((pr) => `- "${pr.translation}" by ${pr.author}`).join("\n");

	// Build data sections - always include blocker info for status sections
	const dataSections: string[] = [
		`MERGED THIS WEEK (${shipped.length} PRs):\n${shippedList}`,
	];

	// Always include blocker data (for status sections)
	if (activeBlockers.length > 0) {
		const blockerList = activeBlockers
			.map((b) => {
				const mentions =
					b.mentionedUsers.length > 0
						? ` (mentions: ${b.mentionedUsers.map((u) => `@${u}`).join(", ")})`
						: "";
				return `- ${b.reason} (${b.ageDays} days) - ${b.author}${mentions}`;
			})
			.join("\n");
		dataSections.push(
			`ACTIVE BLOCKERS (${activeBlockers.length}):\n${blockerList}`,
		);
	} else {
		dataSections.push("ACTIVE BLOCKERS (0):\n(none)");
	}

	// Include resolved blockers if we have any
	if (resolvedBlockers.length > 0) {
		const resolvedList = resolvedBlockers
			.map((b) => `- ${b.reason}`)
			.join("\n");
		dataSections.push(
			`BLOCKERS RESOLVED THIS WEEK (${resolvedBlockers.length}):\n${resolvedList}`,
		);
	}

	// Only include in-progress data if we're asking for next week section
	if (opts.includeNextWeek && inProgress.length > 0) {
		const progressList = inProgress
			.map((pr) => `- "${pr.translation}" by ${pr.author}`)
			.join("\n");
		dataSections.push(`IN PROGRESS (${inProgress.length}):\n${progressList}`);
	}

	return `Summarize this week's engineering activity:

${dataSections.join("\n\n")}

Generate the weekly summary following the output requirements.`;
}

/**
 * Build the complete weekly summary prompt object.
 * Options control which sections are included to prevent AI hallucination
 * when we don't have data for certain sections.
 */
export function buildWeeklySummaryPrompt(
	shipped: Array<{ translation: string; author: string }>,
	activeBlockers: Array<{
		reason: string;
		ageDays: number;
		author: string;
		mentionedUsers: string[];
	}>,
	resolvedBlockers: Array<{ reason: string }>,
	inProgress: Array<{ translation: string; author: string }>,
	projectContext?: string,
	options?: WeeklyPromptOptions,
): { system: string; user: string } {
	return {
		system: buildWeeklySummarySystemPrompt(projectContext, options),
		user: buildWeeklySummaryUserPrompt(
			shipped,
			activeBlockers,
			resolvedBlockers,
			inProgress,
			options,
		),
	};
}

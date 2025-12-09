/**
 * Zod schemas for AI structured output.
 * Used with Vercel AI SDK's generateObject() for type-safe AI responses.
 */

import { z } from "zod";

// =============================================================================
// Translation Schema (replaces translateDiff string output)
// =============================================================================

export const CommitCategorySchema = z.enum([
	"feature", // New functionality
	"fix", // Bug fixes
	"improvement", // Enhancements to existing features
	"refactor", // Code quality, no behavior change
	"docs", // Documentation
	"chore", // Maintenance, deps, config
]);

export const TranslationSchema = z.object({
	action: z.enum(["include", "skip"]),
	summary: z
		.string()
		.max(150)
		.describe("Business-value sentence, max 20 words, past tense")
		.nullable(),
	category: CommitCategorySchema.nullable(),
	significance: z
		.enum(["high", "medium", "low"])
		.nullable()
		.describe("high=user-facing, medium=internal, low=minor"),
});

// =============================================================================
// Feature Summary Schema (replaces narrateFeature JSON parsing)
// =============================================================================

export const FeatureSummarySchema = z.object({
	featureName: z
		.string()
		.max(100)
		.describe("Action-oriented headline, max 10 words"),
	impact: z
		.string()
		.max(150)
		.describe("Business value statement, max 20 words"),
});

export type FeatureSummaryOutput = z.infer<typeof FeatureSummarySchema>;

// =============================================================================
// Comment Analysis Schema (replaces analyzeComment JSON parsing)
// =============================================================================

export const CommentAnalysisSchema = z.object({
	action: z.enum(["add_blocker", "resolve_blocker", "none"]),
	description: z
		.string()
		.max(100)
		.describe("Brief blocker description")
		.nullable(),
	mentionedUsers: z
		.array(z.string())
		.describe("GitHub usernames mentioned as blockers (without @ symbol)")
		.default([]),
});

export type CommentAnalysisOutput = z.infer<typeof CommentAnalysisSchema>;

// =============================================================================
// Weekly Summary Schema
// =============================================================================

// Note: No per-field .max() constraints - we validate total word count (<500)
// on the formatted output instead. This lets the AI generate quality content
// without arbitrary truncation.
//
// DESIGN: Status sections vs Content sections
// - blockersAndRisks: STATUS - always required ("None active" is meaningful)
// - helpNeeded: STATUS - always required ("(none)" confirms no escalations)
// - nextWeek: CONTENT - optional (only when we have in-progress data)
//
// Status sections are always shown so execs can quickly confirm "all clear"
// vs worrying if the report is incomplete. Content sections are conditional.
export const WeeklySummarySchema = z.object({
	executiveSummary: z
		.string()
		.describe("1-2 sentence top-line summary of the week"),
	shippedGroups: z
		.array(
			z.object({
				theme: z
					.string()
					.describe("Business area: Auth, Payments, Infrastructure, etc."),
				summary: z.string().describe("1-2 sentence value summary"),
				contributors: z
					.array(z.string())
					.describe("GitHub usernames who contributed"),
			}),
		)
		.describe("3-5 themed groups of shipped work"),
	// STATUS: Nullable - AI returns null when no blockers, we render "None active"
	blockersAndRisks: z
		.string()
		.nullable()
		.describe("Active blockers summary, or null if none"),
	// STATUS: Nullable - AI returns null when no escalations, we render "None this week"
	helpNeeded: z
		.string()
		.nullable()
		.describe("Escalations needed, or null if none"),
	// CONTENT: Optional - only present when in-progress work exists
	nextWeek: z
		.string()
		.optional()
		.describe("Work carrying into next week - only when in-progress exists"),
});

export type WeeklySummaryOutput = z.infer<typeof WeeklySummarySchema>;

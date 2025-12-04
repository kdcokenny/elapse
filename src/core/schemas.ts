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

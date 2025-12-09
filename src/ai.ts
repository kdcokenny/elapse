/**
 * AI service using Vercel AI SDK with Google Gemini.
 * Uses generateObject() with Zod schemas for type-safe structured output.
 */

import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { z } from "zod";
import {
	buildCommentAnalysisPrompt,
	buildFeatureNarratorPrompt,
	buildTranslatorPrompt,
	buildWeeklySummaryPrompt,
	type WeeklyPromptOptions,
} from "./core/prompts";
import {
	type CommentAnalysisOutput,
	CommentAnalysisSchema,
	type FeatureSummaryOutput,
	FeatureSummarySchema,
	TranslationSchema,
	type WeeklySummaryOutput,
	WeeklySummarySchema,
} from "./core/schemas";
import { AIProviderError, AIProviderTimeoutError } from "./errors";
import { aiLogger } from "./logger";

const AI_TIMEOUT_MS = 30000; // 30 seconds
const PROJECT_CONTEXT = process.env.PROJECT_CONTEXT;

if (!process.env.LLM_MODEL_NAME) {
	throw new Error("LLM_MODEL_NAME environment variable is required");
}
const MODEL_ID = process.env.LLM_MODEL_NAME;

/**
 * Create the AI model instance.
 */
function getModel() {
	return google(MODEL_ID);
}

/**
 * Translate a diff into a structured business-value summary.
 * Returns action: "skip" for trivial changes.
 */
export async function translateDiff(
	message: string,
	diff: string,
): Promise<z.infer<typeof TranslationSchema>> {
	const log = aiLogger.child({ operation: "translate" });

	try {
		const prompt = buildTranslatorPrompt(message, diff, PROJECT_CONTEXT);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { object, usage } = await generateObject({
				model: getModel(),
				schema: TranslationSchema,
				system: prompt.system,
				prompt: prompt.user,
				temperature: 0.1,
				abortSignal: controller.signal,
			});

			log.debug(
				{
					tokens: usage?.totalTokens,
					action: object.action,
					category: object.category,
				},
				"Translation complete",
			);

			return object;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		log.error({ err: error }, "Translation failed");
		throw new AIProviderError(
			`AI translation failed: ${(error as Error).message}`,
			undefined,
			error as Error,
		);
	}
}

/**
 * Analyze a PR comment to determine if it indicates a blocker or resolves one.
 * Uses AI to understand natural language blocker signals.
 */
export async function analyzeComment(
	commentBody: string,
	prContext: { title: string; number: number },
): Promise<CommentAnalysisOutput> {
	const log = aiLogger.child({
		operation: "analyzeComment",
		pr: prContext.number,
	});

	try {
		const prompt = buildCommentAnalysisPrompt(
			prContext.title,
			prContext.number,
			commentBody,
		);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { object, usage } = await generateObject({
				model: getModel(),
				schema: CommentAnalysisSchema,
				system: prompt.system,
				prompt: prompt.user,
				temperature: 0.1,
				abortSignal: controller.signal,
			});

			log.debug(
				{
					tokens: usage?.totalTokens,
					pr: prContext.number,
					action: object.action,
				},
				"Comment analysis complete",
			);

			return object;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		// For any generation errors, return none instead of throwing
		log.warn({ err: error }, "Comment analysis failed, defaulting to none");
		return { action: "none", description: null, mentionedUsers: [] };
	}
}

// =============================================================================
// Feature Narration (PR → Feature Summary)
// =============================================================================

/**
 * Generate a feature summary from a PR title and its commit translations.
 * Returns a human-readable feature name and impact statement.
 */
export async function narrateFeature(
	prTitle: string,
	prNumber: number,
	translations: string[],
): Promise<FeatureSummaryOutput> {
	const log = aiLogger.child({ operation: "narrateFeature", pr: prNumber });

	// Handle single translation without AI - infer from it
	if (translations.length === 1 && translations[0]) {
		return inferFeatureFromSingle(prTitle, translations[0]);
	}

	// Handle empty case
	if (translations.length === 0) {
		return inferFeatureFromTitle(prTitle);
	}

	try {
		const prompt = buildFeatureNarratorPrompt(
			prTitle,
			prNumber,
			translations,
			PROJECT_CONTEXT,
		);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { object, usage } = await generateObject({
				model: getModel(),
				schema: FeatureSummarySchema,
				system: prompt.system,
				prompt: prompt.user,
				temperature: 0.1,
				abortSignal: controller.signal,
			});

			log.debug(
				{
					tokens: usage?.totalTokens,
					prNumber,
					translationCount: translations.length,
				},
				"Feature narration complete",
			);

			return object;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		// For generation errors, use fallback
		log.warn({ err: error }, "Feature narration failed, using fallback");
		return inferFeatureFromTitle(prTitle);
	}
}

/**
 * Infer a feature summary from a single translation.
 */
function inferFeatureFromSingle(
	prTitle: string,
	translation: string,
): FeatureSummaryOutput {
	// Use the translation as the impact, derive feature name from PR title
	const featureName = cleanPRTitle(prTitle);
	return {
		featureName,
		impact: translation,
	};
}

/**
 * Infer a feature summary from just the PR title.
 */
function inferFeatureFromTitle(prTitle: string): FeatureSummaryOutput {
	const featureName = cleanPRTitle(prTitle);
	return {
		featureName,
		impact: "Minor updates and improvements",
	};
}

/**
 * Clean a PR title to be a human-readable feature name.
 * Removes conventional commit prefixes and cleans up formatting.
 */
function cleanPRTitle(title: string): string {
	// Remove conventional commit prefixes
	let cleaned = title
		.replace(
			/^(feat|fix|chore|refactor|docs|style|test|perf|ci|build|revert)(\(.+?\))?:\s*/i,
			"",
		)
		.trim();

	// Capitalize first letter
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}

	// Truncate if too long
	if (cleaned.length > 60) {
		cleaned = `${cleaned.slice(0, 57)}...`;
	}

	return cleaned || "Updates and improvements";
}

// =============================================================================
// Weekly Summary Generation
// =============================================================================

/**
 * Generate a weekly summary from aggregated week data.
 * Returns structured output for the weekly report.
 *
 * Options control which sections are included to prevent AI hallucination
 * when we don't have data for certain sections.
 */
export async function generateWeeklySummary(
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
): Promise<WeeklySummaryOutput> {
	const log = aiLogger.child({ operation: "weeklySummary" });

	// Handle empty week gracefully - return null for status fields (formatting adds fallback)
	if (
		shipped.length === 0 &&
		activeBlockers.length === 0 &&
		inProgress.length === 0
	) {
		return {
			executiveSummary:
				"A quiet week with no significant engineering activity recorded.",
			shippedGroups: [],
			// Status fields null - formatting will render "None active" / "None this week"
			blockersAndRisks: null,
			helpNeeded: null,
			// Content field (nextWeek) omitted when no in-progress data
		};
	}

	try {
		const prompt = buildWeeklySummaryPrompt(
			shipped,
			activeBlockers,
			resolvedBlockers,
			inProgress,
			PROJECT_CONTEXT,
			options,
		);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { object, usage } = await generateObject({
				model: getModel(),
				schema: WeeklySummarySchema,
				system: prompt.system,
				prompt: prompt.user,
				temperature: 0.2, // Slightly higher for creative grouping
				abortSignal: controller.signal,
			});

			log.debug(
				{
					tokens: usage?.totalTokens,
					shippedCount: shipped.length,
					groupCount: object.shippedGroups.length,
				},
				"Weekly summary complete",
			);

			return object;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		log.error({ err: error }, "Weekly summary generation failed");
		throw new AIProviderError(
			`Weekly summary failed: ${(error as Error).message}`,
			undefined,
			error as Error,
		);
	}
}

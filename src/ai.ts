/**
 * AI service using Vercel AI SDK with Google Gemini.
 */

import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { buildNarratorPrompt, buildTranslatorPrompt } from "./core/prompts";
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
 * Translate a diff into a business-value sentence.
 * Returns "SKIP" for trivial changes.
 */
export async function translateDiff(
	message: string,
	diff: string,
): Promise<string> {
	const log = aiLogger.child({ operation: "translate" });

	try {
		const prompt = buildTranslatorPrompt(message, diff, PROJECT_CONTEXT);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { text, usage } = await generateText({
				model: getModel(),
				system: prompt.system,
				prompt: prompt.user,
				abortSignal: controller.signal,
			});

			log.debug(
				{ tokens: usage?.totalTokens, length: text.length },
				"Translation complete",
			);

			return text.trim();
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		log.error({ error }, "Translation failed");
		throw new AIProviderError(
			`AI translation failed: ${(error as Error).message}`,
			undefined,
			error as Error,
		);
	}
}

/**
 * Generate a narrative summary from a list of translations.
 */
export async function narrateDay(
	translations: string[],
	date: string,
): Promise<string> {
	const log = aiLogger.child({ operation: "narrate" });

	// Handle empty or single translation cases without AI
	if (translations.length === 0) {
		return "No significant updates today.";
	}

	const [firstTranslation] = translations;
	if (translations.length === 1 && firstTranslation) {
		return firstTranslation;
	}

	try {
		const prompt = buildNarratorPrompt(translations, date, PROJECT_CONTEXT);

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

		try {
			const { text, usage } = await generateText({
				model: getModel(),
				system: prompt.system,
				prompt: prompt.user,
				abortSignal: controller.signal,
			});

			log.debug(
				{ tokens: usage?.totalTokens, translationCount: translations.length },
				"Narration complete",
			);

			return text.trim();
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			throw new AIProviderTimeoutError(AI_TIMEOUT_MS, error as Error);
		}

		log.error({ error }, "Narration failed");
		throw new AIProviderError(
			`AI narration failed: ${(error as Error).message}`,
			undefined,
			error as Error,
		);
	}
}

import { describe, expect, test } from "bun:test";
import {
	buildFeatureNarratorPrompt,
	buildTranslatorPrompt,
	truncateDiff,
} from "../../src/core/prompts";

describe("truncateDiff", () => {
	test("does not truncate small diffs", () => {
		const diff = "a".repeat(1000);
		const result = truncateDiff(diff);

		expect(result.wasTruncated).toBe(false);
		expect(result.truncated).toBe(diff);
		expect(result.originalSize).toBe(1000);
	});

	test("truncates large diffs", () => {
		// MAX_DIFF_SIZE is 256000 (256KB), so we need a larger diff
		const diff = "a".repeat(300000);
		const result = truncateDiff(diff);

		expect(result.wasTruncated).toBe(true);
		expect(result.truncated.length).toBeLessThan(diff.length);
		expect(result.truncated).toContain("[... diff truncated ...]");
		expect(result.originalSize).toBe(300000);
	});
});

describe("buildTranslatorPrompt", () => {
	test("returns system and user prompts", () => {
		const result = buildTranslatorPrompt("message", "diff");

		expect(result).toHaveProperty("system");
		expect(result).toHaveProperty("user");
		expect(typeof result.system).toBe("string");
		expect(typeof result.user).toBe("string");
	});

	test("passes context to system prompt", () => {
		const result = buildTranslatorPrompt("msg", "diff", "custom context");
		expect(result.system).toContain("custom context");
	});
});

describe("buildFeatureNarratorPrompt", () => {
	test("returns system and user prompts", () => {
		const result = buildFeatureNarratorPrompt("Test PR", 123, ["Update"]);

		expect(result).toHaveProperty("system");
		expect(result).toHaveProperty("user");
	});

	test("passes context to system prompt", () => {
		const result = buildFeatureNarratorPrompt(
			"Test PR",
			123,
			["Update"],
			"my project",
		);
		expect(result.system).toContain("my project");
	});
});

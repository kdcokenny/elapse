import { describe, expect, test } from "bun:test";
import {
	buildFeatureNarratorPrompt,
	buildFeatureNarratorUserPrompt,
	buildTranslatorPrompt,
	buildTranslatorSystemPrompt,
	buildTranslatorUserPrompt,
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
		const diff = "a".repeat(10000);
		const result = truncateDiff(diff);

		expect(result.wasTruncated).toBe(true);
		expect(result.truncated.length).toBeLessThan(diff.length);
		expect(result.truncated).toContain("[... diff truncated ...]");
		expect(result.originalSize).toBe(10000);
	});
});

describe("buildTranslatorSystemPrompt", () => {
	test("includes default context when not provided", () => {
		const prompt = buildTranslatorSystemPrompt();
		expect(prompt).toContain("a software project");
	});

	test("includes custom context when provided", () => {
		const prompt = buildTranslatorSystemPrompt("a dental SaaS platform");
		expect(prompt).toContain("a dental SaaS platform");
	});

	test("includes SKIP instruction", () => {
		const prompt = buildTranslatorSystemPrompt();
		expect(prompt).toContain("SKIP");
	});

	test("includes word limit", () => {
		const prompt = buildTranslatorSystemPrompt();
		expect(prompt).toContain("20 words");
	});
});

describe("buildTranslatorUserPrompt", () => {
	test("includes commit message for normal messages", () => {
		const prompt = buildTranslatorUserPrompt("Add user auth", "diff content");
		expect(prompt).toContain("Commit message: Add user auth");
	});

	test("notes vague messages", () => {
		const prompt = buildTranslatorUserPrompt("fix", "diff content");
		expect(prompt).toContain("commit message is vague");
		expect(prompt).toContain('("fix")');
	});

	test("includes diff content", () => {
		const prompt = buildTranslatorUserPrompt("message", "diff content here");
		expect(prompt).toContain("diff content here");
	});

	test("notes when diff is truncated", () => {
		const largeDiff = "a".repeat(10000);
		const prompt = buildTranslatorUserPrompt("message", largeDiff);
		expect(prompt).toContain("diff was truncated");
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

describe("buildFeatureNarratorUserPrompt", () => {
	test("handles empty translations", () => {
		const prompt = buildFeatureNarratorUserPrompt("Test PR", 123, []);
		expect(prompt).toContain("No meaningful commits");
	});

	test("numbers translations", () => {
		const translations = ["Added auth", "Fixed bug", "Improved perf"];
		const prompt = buildFeatureNarratorUserPrompt("Test PR", 123, translations);

		expect(prompt).toContain("1. Added auth");
		expect(prompt).toContain("2. Fixed bug");
		expect(prompt).toContain("3. Improved perf");
	});

	test("includes PR title and number", () => {
		const prompt = buildFeatureNarratorUserPrompt("My Feature", 456, [
			"Update",
		]);
		expect(prompt).toContain("PR #456");
		expect(prompt).toContain("My Feature");
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

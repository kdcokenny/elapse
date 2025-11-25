import { describe, expect, test } from "bun:test";
import {
	buildNarratorPrompt,
	buildNarratorUserPrompt,
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

describe("buildNarratorUserPrompt", () => {
	test("handles empty translations", () => {
		const prompt = buildNarratorUserPrompt([], "2024-01-15");
		expect(prompt).toBe("No updates today.");
	});

	test("numbers translations", () => {
		const translations = ["Added auth", "Fixed bug", "Improved perf"];
		const prompt = buildNarratorUserPrompt(translations, "2024-01-15");

		expect(prompt).toContain("1. Added auth");
		expect(prompt).toContain("2. Fixed bug");
		expect(prompt).toContain("3. Improved perf");
	});

	test("includes date", () => {
		const prompt = buildNarratorUserPrompt(["Update"], "2024-01-15");
		expect(prompt).toContain("2024-01-15");
	});
});

describe("buildNarratorPrompt", () => {
	test("returns system and user prompts", () => {
		const result = buildNarratorPrompt(["Update"], "2024-01-15");

		expect(result).toHaveProperty("system");
		expect(result).toHaveProperty("user");
	});

	test("passes context to system prompt", () => {
		const result = buildNarratorPrompt(["Update"], "2024-01-15", "my project");
		expect(result.system).toContain("my project");
	});
});

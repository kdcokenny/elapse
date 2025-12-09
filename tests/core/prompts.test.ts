import { describe, expect, test } from "bun:test";
import {
	buildFeatureNarratorPrompt,
	buildTranslatorPrompt,
	buildWeeklySummaryPrompt,
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

	test("includes guidance for handling contradictory signals", () => {
		const { system } = buildTranslatorPrompt("test message", "test diff");

		// Verify signal priority guidance
		expect(system).toContain("PRIORITY ORDER");
		expect(system).toContain("Title > Branch name > Diff > Body");

		// Verify result-focused framing
		expect(system).toContain("DESCRIBE THE RESULT");

		// Verify flag/toggle guidance
		expect(system).toContain("FLAG/TOGGLE CHANGES");
		expect(system).toContain("disable X");
		expect(system).toContain("enable X");

		// Verify negative prefix handling
		expect(system).toContain("NEGATIVE PREFIXES");
		expect(system).toContain("disable, remove, un-, deprecate");
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

describe("buildWeeklySummaryPrompt", () => {
	test("builds prompt with all sections", () => {
		const prompt = buildWeeklySummaryPrompt(
			[{ translation: "Added auth", author: "alice" }],
			[
				{
					reason: "Waiting on API",
					ageDays: 5,
					author: "bob",
					mentionedUsers: ["eve"],
				},
			],
			[{ reason: "Fixed deps" }],
			[{ translation: "Working on payments", author: "carol" }],
		);

		expect(prompt.system).toContain("stakeholders");
		expect(prompt.user).toContain("MERGED THIS WEEK (1 PRs)");
		expect(prompt.user).toContain("ACTIVE BLOCKERS (1)");
		expect(prompt.user).toContain("@eve");
	});

	test("handles empty data", () => {
		const prompt = buildWeeklySummaryPrompt([], [], [], []);

		expect(prompt.user).toContain("(none)");
		expect(prompt.user).toContain("MERGED THIS WEEK (0 PRs)");
	});

	test("includes project context when provided", () => {
		const prompt = buildWeeklySummaryPrompt([], [], [], [], "my project");

		expect(prompt.system).toContain("my project");
	});
});

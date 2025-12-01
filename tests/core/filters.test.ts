import { describe, expect, test } from "bun:test";
import {
	type Commit,
	filterCommits,
	isBotCommit,
	isLockfileOnlyCommit,
	isMergeCommit,
	isVagueMessage,
	type Sender,
} from "../../src/core/filters";

const makeCommit = (overrides: Partial<Commit> = {}): Commit => ({
	id: "abc123",
	message: "Add new feature",
	author: { name: "John Doe", email: "john@example.com" },
	added: [],
	modified: [],
	removed: [],
	...overrides,
});

const makeSender = (overrides: Partial<Sender> = {}): Sender => ({
	login: "johndoe",
	type: "User",
	...overrides,
});

describe("isBotCommit", () => {
	test("identifies GitHub bot type", () => {
		const commit = makeCommit();
		const sender = makeSender({ type: "Bot" });
		expect(isBotCommit(commit, sender)).toBe(true);
	});

	test("identifies dependabot by sender login", () => {
		const commit = makeCommit();
		const sender = makeSender({ login: "dependabot[bot]" });
		expect(isBotCommit(commit, sender)).toBe(true);
	});

	test("identifies renovate by sender login", () => {
		const commit = makeCommit();
		const sender = makeSender({ login: "renovate[bot]" });
		expect(isBotCommit(commit, sender)).toBe(true);
	});

	test("identifies github-actions bot", () => {
		const commit = makeCommit();
		const sender = makeSender({ login: "github-actions[bot]" });
		expect(isBotCommit(commit, sender)).toBe(true);
	});

	test("identifies bot by commit author name", () => {
		const commit = makeCommit({ author: { name: "dependabot[bot]" } });
		const sender = makeSender();
		expect(isBotCommit(commit, sender)).toBe(true);
	});

	test("does not flag human commits", () => {
		const commit = makeCommit();
		const sender = makeSender();
		expect(isBotCommit(commit, sender)).toBe(false);
	});
});

describe("isLockfileOnlyCommit", () => {
	test("identifies package-lock.json only changes", () => {
		const commit = makeCommit({ modified: ["package-lock.json"] });
		expect(isLockfileOnlyCommit(commit)).toBe(true);
	});

	test("identifies yarn.lock only changes", () => {
		const commit = makeCommit({ modified: ["yarn.lock"] });
		expect(isLockfileOnlyCommit(commit)).toBe(true);
	});

	test("identifies pnpm-lock.yaml only changes", () => {
		const commit = makeCommit({ modified: ["pnpm-lock.yaml"] });
		expect(isLockfileOnlyCommit(commit)).toBe(true);
	});

	test("identifies bun.lockb only changes", () => {
		const commit = makeCommit({ modified: ["bun.lockb"] });
		expect(isLockfileOnlyCommit(commit)).toBe(true);
	});

	test("identifies multiple lockfiles only", () => {
		const commit = makeCommit({
			modified: ["package-lock.json", "yarn.lock"],
		});
		expect(isLockfileOnlyCommit(commit)).toBe(true);
	});

	test("does not flag commits with source changes", () => {
		const commit = makeCommit({
			added: ["src/feature.ts"],
			modified: ["package-lock.json"],
		});
		expect(isLockfileOnlyCommit(commit)).toBe(false);
	});

	test("does not flag commits with no file info", () => {
		const commit = makeCommit();
		expect(isLockfileOnlyCommit(commit)).toBe(false);
	});
});

describe("isMergeCommit", () => {
	test("identifies merge pull request commits", () => {
		const commit = makeCommit({
			message: "Merge pull request #123 from feature-branch",
		});
		expect(isMergeCommit(commit)).toBe(true);
	});

	test("identifies merge branch commits", () => {
		const commit = makeCommit({
			message: "Merge branch 'main' into feature",
		});
		expect(isMergeCommit(commit)).toBe(true);
	});

	test("identifies merge remote-tracking commits", () => {
		const commit = makeCommit({
			message: "Merge remote-tracking branch 'origin/main'",
		});
		expect(isMergeCommit(commit)).toBe(true);
	});

	test("does not flag normal commits", () => {
		const commit = makeCommit({ message: "Merge these two modules together" });
		expect(isMergeCommit(commit)).toBe(false);
	});
});

describe("isVagueMessage", () => {
	test.each([
		["fix", true],
		["Fix", true],
		["FIX", true],
		["update", true],
		["wip", true],
		["WIP", true],
		["changes", true],
		["change", true],
		["stuff", true],
		["misc", true],
		["temp", true],
		[".", true],
		["...", true],
		["x", true],
	])('"%s" is vague: %s', (message, expected) => {
		expect(isVagueMessage(message)).toBe(expected);
	});

	test.each([
		["Add user authentication feature", false],
		["Fix null pointer exception in UserService", false],
		["Refactor database connection pooling", false],
		["Update React to version 18", false],
		["fix: resolve login issue", false],
		["wip: authentication flow", false],
	])('"%s" is not vague', (message) => {
		expect(isVagueMessage(message)).toBe(false);
	});
});

describe("filterCommits", () => {
	test("separates included and excluded commits", () => {
		const commits = [
			makeCommit({ id: "1", message: "Add feature" }),
			makeCommit({ id: "2", message: "Merge branch 'main'" }),
			makeCommit({ id: "3", modified: ["package-lock.json"] }),
			makeCommit({ id: "4", message: "Fix bug" }),
		];
		const sender = makeSender();

		const result = filterCommits(commits, sender);

		expect(result.included).toHaveLength(2);
		expect(result.included.map((c) => c.id)).toEqual(["1", "4"]);

		expect(result.excluded).toHaveLength(2);
		expect(result.excluded.map((e) => e.reason)).toEqual([
			"merge",
			"lockfile-only",
		]);
	});

	test("handles empty commit list", () => {
		const result = filterCommits([], makeSender());
		expect(result.included).toHaveLength(0);
		expect(result.excluded).toHaveLength(0);
	});
});

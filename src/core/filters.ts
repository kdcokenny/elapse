/**
 * Pure functions for filtering commits.
 * These determine which commits should be processed by Elapse.
 */

export interface Commit {
	id: string;
	message: string;
	author: {
		name?: string | null;
		email?: string | null;
		username?: string | null;
	};
	added?: string[];
	modified?: string[];
	removed?: string[];
}

export interface Sender {
	login: string;
	type?: string;
}

// Bot author patterns
const BOT_PATTERNS = [
	/\[bot\]$/i,
	/^dependabot/i,
	/^renovate/i,
	/^github-actions/i,
	/^greenkeeper/i,
	/^snyk-bot/i,
];

// Lockfile patterns - commits that only touch these are noise
const LOCKFILE_PATTERNS = [
	/package-lock\.json$/,
	/yarn\.lock$/,
	/pnpm-lock\.yaml$/,
	/bun\.lockb$/,
	/Gemfile\.lock$/,
	/composer\.lock$/,
	/Cargo\.lock$/,
	/poetry\.lock$/,
	/go\.sum$/,
];

// Vague commit message patterns - AI should rely more on diff for these
const VAGUE_MESSAGE_PATTERNS = [
	/^fix$/i,
	/^update$/i,
	/^wip$/i,
	/^changes?$/i,
	/^stuff$/i,
	/^misc$/i,
	/^temp$/i,
	/^\.+$/,
	/^[a-z]$/i,
];

/**
 * Check if a commit is from a bot account.
 */
export function isBotCommit(commit: Commit, sender: Sender): boolean {
	// GitHub marks bots with type
	if (sender.type === "Bot") return true;

	// Check sender login against patterns
	if (BOT_PATTERNS.some((p) => p.test(sender.login))) return true;

	// Check commit author
	const authorName = commit.author.name || commit.author.username || "";
	if (BOT_PATTERNS.some((p) => p.test(authorName))) return true;

	return false;
}

/**
 * Check if a commit only modifies lockfiles.
 */
export function isLockfileOnlyCommit(commit: Commit): boolean {
	const allFiles = [
		...(commit.added || []),
		...(commit.modified || []),
		...(commit.removed || []),
	];

	// If no files listed, don't filter (we don't have enough info)
	if (allFiles.length === 0) return false;

	// Check if ALL files match lockfile patterns
	return allFiles.every((f) => LOCKFILE_PATTERNS.some((p) => p.test(f)));
}

/**
 * Check if a commit is a merge commit.
 */
export function isMergeCommit(commit: Commit): boolean {
	const firstLine = commit.message.split("\n")[0] ?? "";
	return /^Merge (pull request|branch|remote-tracking)/i.test(firstLine);
}

/**
 * Check if a commit message is vague (AI should focus on diff).
 */
export function isVagueMessage(message: string): boolean {
	const firstLine = message.trim().split("\n")[0] ?? "";
	return VAGUE_MESSAGE_PATTERNS.some((p) => p.test(firstLine));
}

/**
 * Main filter function - determines if a commit should be processed.
 * Returns true if the commit should be processed, false if it should be skipped.
 */
export function shouldProcessCommit(commit: Commit, sender: Sender): boolean {
	// Skip bot commits
	if (isBotCommit(commit, sender)) return false;

	// Skip merge commits
	if (isMergeCommit(commit)) return false;

	// Skip lockfile-only commits
	if (isLockfileOnlyCommit(commit)) return false;

	return true;
}

/**
 * Filter an array of commits, returning only those that should be processed.
 */
export function filterCommits(
	commits: Commit[],
	sender: Sender,
): {
	included: Commit[];
	excluded: Array<{ commit: Commit; reason: string }>;
} {
	const included: Commit[] = [];
	const excluded: Array<{ commit: Commit; reason: string }> = [];

	for (const commit of commits) {
		if (isBotCommit(commit, sender)) {
			excluded.push({ commit, reason: "bot" });
		} else if (isMergeCommit(commit)) {
			excluded.push({ commit, reason: "merge" });
		} else if (isLockfileOnlyCommit(commit)) {
			excluded.push({ commit, reason: "lockfile-only" });
		} else {
			included.push(commit);
		}
	}

	return { included, excluded };
}

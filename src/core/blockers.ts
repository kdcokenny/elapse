/**
 * Blocker detection and types for extracting blockers from commits and PRs.
 */

/**
 * Blocker signal extracted from commit messages.
 */
export interface CommitBlockerSignal {
	type: "wip" | "todo" | "blocked" | "depends";
	raw: string;
	dependency?: string; // PR/issue number if depends on something
}

/**
 * Blocker extracted from PR data via GitHub API or AI analysis of comments.
 */
export interface PRBlocker {
	type:
		| "changes_requested"
		| "pending_review"
		| "label"
		| "description"
		| "commit_signal"
		| "comment"; // AI-detected from PR comment
	description: string;
	reviewer?: string; // Who requested changes / is pending review
	prNumber?: number;
	prTitle?: string; // PR title for display
	branch: string;
	user: string; // PR author or commit author
	commentId?: number; // Source comment ID (for comment type)
	detectedAt?: string; // ISO timestamp when blocker was detected
}

/**
 * Result of blocker extraction from a PR.
 */
export interface BlockerResult {
	blockers: PRBlocker[];
	prTitle?: string;
	prUrl?: string;
}

/**
 * Summary of a blocker for report display.
 */
export interface BlockerSummary {
	branch: string;
	description: string;
	user: string;
	prNumber?: number;
	prTitle?: string;
}

// Patterns for detecting blockers in commit messages
const BLOCKER_PATTERNS: Array<{
	pattern: RegExp;
	type: CommitBlockerSignal["type"];
}> = [
	{ pattern: /^WIP:\s*/i, type: "wip" },
	{ pattern: /^TODO:\s*/i, type: "todo" },
	{ pattern: /^BLOCKED:\s*/i, type: "blocked" },
	{ pattern: /\bWIP\b/i, type: "wip" },
	{ pattern: /depends on #(\d+)/i, type: "depends" },
	{ pattern: /waiting on #(\d+)/i, type: "depends" },
	{ pattern: /blocked by #(\d+)/i, type: "depends" },
];

// Labels that indicate blockers (configurable via env)
const BLOCKER_LABELS = (
	process.env.BLOCKER_LABELS || "blocked,waiting-on-review,needs-review,wip"
)
	.split(",")
	.map((l) => l.trim().toLowerCase())
	.filter((l) => l.length > 0);

/**
 * Parse blocker signals from a commit message.
 */
export function parseCommitBlockers(message: string): CommitBlockerSignal[] {
	const signals: CommitBlockerSignal[] = [];

	for (const { pattern, type } of BLOCKER_PATTERNS) {
		const match = message.match(pattern);
		if (match) {
			signals.push({
				type,
				raw: match[0],
				dependency: match[1], // capture group if present
			});
		}
	}

	return signals;
}

/**
 * Check if a label name matches any of the configured blocker labels.
 */
export function isBlockerLabel(labelName: string): boolean {
	const normalized = labelName.toLowerCase();
	return BLOCKER_LABELS.some((bl) => normalized.includes(bl));
}

/**
 * Parse blocker section from PR description.
 * Looks for "## Blockers" or "# Blockers:" sections.
 */
export function parseDescriptionBlockers(body: string | null): string | null {
	if (!body) return null;

	const blockerMatch = body.match(
		/##?\s*blockers?:?\s*\n([\s\S]*?)(?=\n##|\n\n\n|$)/i,
	);
	if (blockerMatch?.[1]) {
		const content = blockerMatch[1].trim();
		// Get first non-empty line
		const firstLine = content.split("\n").find((l) => l.trim().length > 0);
		return firstLine?.replace(/^[-*]\s*/, "").trim() || null;
	}

	return null;
}

/**
 * Get priority for blocker types (lower = more urgent).
 */
export function blockerPriority(type: PRBlocker["type"]): number {
	const priorities: Record<PRBlocker["type"], number> = {
		changes_requested: 1, // Most urgent
		pending_review: 2,
		comment: 2.5, // AI-detected from PR comments
		label: 3,
		description: 4,
		commit_signal: 5,
	};
	return priorities[type];
}

/**
 * Generate blockers section from a list of blockers.
 * Groups by branch and picks highest priority blocker per branch.
 */
export function generateBlockersSummary(
	blockers: PRBlocker[],
): BlockerSummary[] {
	if (blockers.length === 0) return [];

	// Group by branch
	const byBranch = new Map<string, PRBlocker[]>();
	for (const b of blockers) {
		if (!byBranch.has(b.branch)) {
			byBranch.set(b.branch, []);
		}
		byBranch.get(b.branch)?.push(b);
	}

	const summaries: BlockerSummary[] = [];
	for (const [branch, branchBlockers] of byBranch) {
		// Sort by priority (ascending) and pick first
		const sorted = branchBlockers.sort(
			(a, b) => blockerPriority(a.type) - blockerPriority(b.type),
		);
		const primary = sorted[0];

		if (primary) {
			summaries.push({
				branch,
				description: primary.description,
				user: primary.user,
				prNumber: primary.prNumber,
				prTitle: primary.prTitle,
			});
		}
	}

	return summaries;
}

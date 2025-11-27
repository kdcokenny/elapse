/**
 * Blocker detection and types for extracting blockers from PRs.
 */

/**
 * Blocker extracted from PR data via GitHub API or AI analysis of comments.
 */
export interface PRBlocker {
	type:
		| "changes_requested"
		| "pending_review"
		| "label"
		| "description"
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
 * Summary of a blocker for report display.
 */
export interface BlockerSummary {
	branch: string;
	description: string;
	user: string;
	prNumber?: number;
	prTitle?: string;
}

/**
 * Blockers grouped by user for report display.
 * Consolidates multiple blockers per person into a single entry.
 */
export interface UserBlockerGroup {
	user: string;
	blockers: Array<{
		description: string;
		branch: string;
		prNumber?: number;
		prTitle?: string;
	}>;
}

// Labels that indicate blockers (configurable via env)
const BLOCKER_LABELS = (
	process.env.BLOCKER_LABELS || "blocked,waiting-on-review,needs-review,wip"
)
	.split(",")
	.map((l) => l.trim().toLowerCase())
	.filter((l) => l.length > 0);

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
 * Group blockers by user for consolidated display.
 * Returns users sorted by blocker count (descending), then alphabetically.
 */
export function groupBlockersByUser(
	blockers: BlockerSummary[],
): UserBlockerGroup[] {
	if (blockers.length === 0) return [];

	// Group by user
	const byUser = new Map<string, UserBlockerGroup["blockers"]>();
	for (const b of blockers) {
		let userBlockers = byUser.get(b.user);
		if (!userBlockers) {
			userBlockers = [];
			byUser.set(b.user, userBlockers);
		}
		userBlockers.push({
			description: b.description,
			branch: b.branch,
			prNumber: b.prNumber,
			prTitle: b.prTitle,
		});
	}

	// Convert to array and sort: by blocker count (desc), then alphabetically
	const groups: UserBlockerGroup[] = Array.from(byUser.entries())
		.map(([user, blockers]) => ({ user, blockers }))
		.sort((a, b) => {
			if (b.blockers.length !== a.blockers.length) {
				return b.blockers.length - a.blockers.length;
			}
			return a.user.localeCompare(b.user);
		});

	return groups;
}

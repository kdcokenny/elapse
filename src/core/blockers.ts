/**
 * Blocker detection and types for extracting blockers from PRs.
 */

/**
 * Summary of a blocker for report display.
 */
export interface BlockerSummary {
	branch: string;
	description: string;
	user: string;
	prNumber?: number;
	prTitle?: string;
	/** Repository in "owner/repo" format for PR links */
	repo?: string;
	/** ISO timestamp when blocker was detected (for age calculation) */
	detectedAt?: string;
	/** GitHub usernames mentioned as blockers */
	mentionedUsers?: string[];
}

/**
 * Blockers grouped by user for report display.
 * Consolidates multiple blockers per person into a single entry.
 */
export interface UserBlockerGroup {
	user: string;
	/** Total number of blockers for this user */
	blockerCount: number;
	/** Age of oldest blocker (e.g., "4 days") */
	oldestAge?: string;
	blockers: Array<{
		description: string;
		branch: string;
		prNumber?: number;
		prTitle?: string;
		/** Repository in "owner/repo" format for PR links */
		repo?: string;
		/** Age of this blocker (e.g., "2 days") */
		age?: string;
		/** GitHub usernames mentioned as blockers */
		mentionedUsers?: string[];
	}>;
}

// Labels that indicate blockers (configurable via env)
// Default per spec: blocked, blocking, needs-help, waiting, on-hold, stalled
const BLOCKER_LABELS = (
	process.env.BLOCKER_LABELS ||
	"blocked,blocking,needs-help,waiting,on-hold,stalled"
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
 * Calculate age in days from an ISO timestamp.
 * Returns formatted string like "1 day" or "4 days".
 */
function calculateAgeDays(detectedAt: string | undefined): string | undefined {
	if (!detectedAt) return undefined;
	const now = Date.now();
	const detected = new Date(detectedAt).getTime();
	const days = Math.floor((now - detected) / (24 * 60 * 60 * 1000));
	if (days === 0) return "today";
	if (days === 1) return "1 day";
	return `${days} days`;
}

/**
 * Group blockers by user for consolidated display.
 * Returns users sorted by blocker count (descending), then alphabetically.
 * Calculates age for each blocker and oldest age per group.
 */
export function groupBlockersByUser(
	blockers: BlockerSummary[],
): UserBlockerGroup[] {
	if (blockers.length === 0) return [];

	// Group by user with age calculation
	const byUser = new Map<
		string,
		{ blockers: UserBlockerGroup["blockers"]; timestamps: (number | null)[] }
	>();

	for (const b of blockers) {
		let userData = byUser.get(b.user);
		if (!userData) {
			userData = { blockers: [], timestamps: [] };
			byUser.set(b.user, userData);
		}

		const age = calculateAgeDays(b.detectedAt);
		const timestamp = b.detectedAt ? new Date(b.detectedAt).getTime() : null;

		userData.blockers.push({
			description: b.description,
			branch: b.branch,
			prNumber: b.prNumber,
			prTitle: b.prTitle,
			repo: b.repo,
			age,
			mentionedUsers: b.mentionedUsers,
		});
		userData.timestamps.push(timestamp);
	}

	// Convert to array and calculate oldest age per group
	const groups: UserBlockerGroup[] = Array.from(byUser.entries())
		.map(([user, data]) => {
			// Find oldest timestamp (smallest value)
			const validTimestamps = data.timestamps.filter(
				(t): t is number => t !== null,
			);
			let oldestAge: string | undefined;
			if (validTimestamps.length > 0) {
				const oldest = Math.min(...validTimestamps);
				const days = Math.floor((Date.now() - oldest) / (24 * 60 * 60 * 1000));
				oldestAge =
					days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
			}

			return {
				user,
				blockerCount: data.blockers.length,
				oldestAge,
				blockers: data.blockers,
			};
		})
		.sort((a, b) => {
			if (b.blockerCount !== a.blockerCount) {
				return b.blockerCount - a.blockerCount;
			}
			return a.user.localeCompare(b.user);
		});

	return groups;
}

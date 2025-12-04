/**
 * Branch classification logic for determining shipped vs in-progress work.
 */

// Default: main, master. Configurable via MAIN_BRANCHES env
const MAIN_BRANCHES = (process.env.MAIN_BRANCHES || "main,master")
	.split(",")
	.map((b) => b.trim())
	.filter((b) => b.length > 0);

/**
 * Check if a branch is considered a main/production branch.
 * Supports exact matches and wildcard patterns (e.g., "release/*").
 */
function isMainBranch(branch: string): boolean {
	return MAIN_BRANCHES.some((main) => {
		if (main.includes("*")) {
			// Convert wildcard to regex pattern
			const pattern = new RegExp(`^${main.replace(/\*/g, ".*")}$`);
			return pattern.test(branch);
		}
		return branch === main;
	});
}

export type WorkSection = "shipped" | "progress";

/**
 * Classify a branch as either "shipped" (main branch) or "progress" (feature branch).
 */
export function classifyBranch(branch: string): WorkSection {
	return isMainBranch(branch) ? "shipped" : "progress";
}

/**
 * Extract branch name from a Git ref (e.g., "refs/heads/main" → "main").
 */
export function extractBranchFromRef(ref: string): string {
	return ref.replace("refs/heads/", "");
}

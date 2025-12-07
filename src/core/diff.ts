/**
 * Pure functions for processing git diffs.
 * Handles stripping oversized files to reduce noise in AI processing.
 */

/**
 * Maximum size for a single file's diff content.
 * Above this threshold, the file is stripped from the diff before AI processing.
 *
 * Rationale: 50KB ≈ 1000+ lines. No developer hand-types that much in one commit.
 * This catches: lock files, migration snapshots, minified bundles, generated code.
 *
 * OPTIMIZATION SCOPE: JavaScript/TypeScript projects
 * Tested with: React, Next.js, Remix, Bun, Node.js, Turborepo monorepos
 *
 * For other ecosystems (Rust, Go, Python, etc.):
 * - Open a PR to adjust thresholds for your ecosystem
 */
const MAX_SINGLE_FILE_DIFF_SIZE = 50000; // 50KB

export interface StrippedDiffResult {
	filteredDiff: string;
	strippedFiles: string[];
}

/**
 * Strip oversized files from a unified diff.
 * Returns the filtered diff and list of stripped files.
 *
 * Files exceeding the size limit are replaced with a placeholder
 * so the AI knows something was stripped.
 */
export function stripOversizedFiles(diff: string): StrippedDiffResult {
	const strippedFiles: string[] = [];
	const fileChunks: string[] = [];

	// Split diff by file boundaries using matchAll
	const fileDiffRegex = /^diff --git a\/(.+?) b\/.+$/gm;
	const matches = [...diff.matchAll(fileDiffRegex)];

	// Handle case where diff has no file boundaries (shouldn't happen, but be safe)
	if (matches.length === 0) {
		return { filteredDiff: diff, strippedFiles: [] };
	}

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		if (!match || match.index === undefined) continue;

		const start = match.index;
		const fileName = match[1] ?? "unknown";

		// End is either the start of the next file or end of diff
		const end = matches[i + 1]?.index ?? diff.length;
		const fileContent = diff.slice(start, end);

		if (fileContent.length > MAX_SINGLE_FILE_DIFF_SIZE) {
			strippedFiles.push(fileName);
			// Add placeholder so AI knows files were stripped
			const sizeKB = Math.round(fileContent.length / 1000);
			fileChunks.push(
				`diff --git a/${fileName} b/${fileName}\n[Stripped: ${sizeKB}KB exceeds 50KB limit]\n`,
			);
		} else {
			fileChunks.push(fileContent);
		}
	}

	return {
		filteredDiff: fileChunks.join(""),
		strippedFiles,
	};
}

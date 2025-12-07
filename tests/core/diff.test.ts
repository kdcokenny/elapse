import { describe, expect, test } from "bun:test";
import { stripOversizedFiles } from "../../src/core/diff";

describe("stripOversizedFiles", () => {
	test("returns unchanged diff when no files are oversized", () => {
		const diff = `diff --git a/small.ts b/small.ts
--- a/small.ts
+++ b/small.ts
@@ -1,3 +1,4 @@
+// Added comment
 const foo = 1;`;

		const result = stripOversizedFiles(diff);

		expect(result.filteredDiff).toBe(diff);
		expect(result.strippedFiles).toEqual([]);
	});

	test("strips files exceeding 50KB", () => {
		const smallFileContent = `diff --git a/small.ts b/small.ts
--- a/small.ts
+++ b/small.ts
@@ -1 +1 @@
-const old = 1;
+const new = 2;
`;
		// Create a large file content (>50KB)
		const largeContent = "a".repeat(60000);
		const largeFileContent = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
${largeContent}
`;

		const diff = smallFileContent + largeFileContent;
		const result = stripOversizedFiles(diff);

		expect(result.strippedFiles).toEqual(["package-lock.json"]);
		expect(result.filteredDiff).toContain("small.ts");
		expect(result.filteredDiff).toContain(
			"[Stripped: 60KB exceeds 50KB limit]",
		);
		expect(result.filteredDiff).not.toContain(largeContent);
	});

	test("handles multiple oversized files", () => {
		const small = `diff --git a/index.ts b/index.ts
--- a/index.ts
+++ b/index.ts
@@ -1 +1 @@
-export {};
+export { foo };
`;
		const large1 = `diff --git a/lock1.json b/lock1.json
${"x".repeat(55000)}
`;
		const large2 = `diff --git a/lock2.json b/lock2.json
${"y".repeat(55000)}
`;

		const diff = small + large1 + large2;
		const result = stripOversizedFiles(diff);

		expect(result.strippedFiles).toEqual(["lock1.json", "lock2.json"]);
		expect(result.filteredDiff).toContain("index.ts");
	});

	test("handles empty diff", () => {
		const result = stripOversizedFiles("");
		expect(result.filteredDiff).toBe("");
		expect(result.strippedFiles).toEqual([]);
	});

	test("handles diff without file boundaries", () => {
		const weirdDiff = "some text without diff headers";
		const result = stripOversizedFiles(weirdDiff);

		expect(result.filteredDiff).toBe(weirdDiff);
		expect(result.strippedFiles).toEqual([]);
	});
});

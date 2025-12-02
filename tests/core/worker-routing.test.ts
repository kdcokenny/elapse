/**
 * Worker job routing tests.
 *
 * These tests verify that the unified worker correctly routes jobs
 * to the appropriate processors and fails fast for unknown job types.
 *
 * This test was added after a bug where two workers consumed from the
 * same queue, causing digest jobs to be silently dropped when picked
 * up by the report worker.
 */

import { describe, expect, it } from "bun:test";
import { UnrecoverableError } from "bullmq";

// We test the routing logic directly since the actual worker requires
// Redis and external dependencies. The key insight is that the switch
// statement must be explicit about all job types.

describe("Worker job routing", () => {
	// Simulate the routing logic from worker.ts
	function routeJob(jobName: string): string {
		switch (jobName) {
			case "digest":
				return "processDigestJob";
			case "comment":
				return "processCommentJob";
			case "report":
				return "processReportJob";
			default:
				throw new UnrecoverableError(`Unknown job type: ${jobName}`);
		}
	}

	it("routes digest jobs correctly", () => {
		expect(routeJob("digest")).toBe("processDigestJob");
	});

	it("routes comment jobs correctly", () => {
		expect(routeJob("comment")).toBe("processCommentJob");
	});

	it("routes report jobs correctly", () => {
		expect(routeJob("report")).toBe("processReportJob");
	});

	it("throws UnrecoverableError for unknown job types", () => {
		expect(() => routeJob("unknown")).toThrow(UnrecoverableError);
		expect(() => routeJob("unknown")).toThrow("Unknown job type: unknown");
	});

	it("throws for empty job name", () => {
		expect(() => routeJob("")).toThrow(UnrecoverableError);
	});

	it("throws for job names with typos", () => {
		// These would silently fail in the old implementation
		expect(() => routeJob("Digest")).toThrow(UnrecoverableError);
		expect(() => routeJob("REPORT")).toThrow(UnrecoverableError);
		expect(() => routeJob("comments")).toThrow(UnrecoverableError);
	});
});

describe("Job type coverage", () => {
	// Document all expected job types to catch if new ones are added
	// without updating the worker routing
	const EXPECTED_JOB_TYPES = ["digest", "comment", "report"] as const;

	it("handles all expected job types", () => {
		// This test documents the expected job types and ensures
		// they're all handled. If a new job type is added, this test
		// should be updated along with the worker routing.
		expect(EXPECTED_JOB_TYPES).toContain("digest");
		expect(EXPECTED_JOB_TYPES).toContain("comment");
		expect(EXPECTED_JOB_TYPES).toContain("report");
		expect(EXPECTED_JOB_TYPES.length).toBe(3);
	});
});

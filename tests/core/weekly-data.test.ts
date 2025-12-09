import { describe, expect, test } from "bun:test";
import {
	calculateBlockerAgeDays,
	getWeekBoundary,
} from "../../src/core/weekly-data";

describe("getWeekBoundary", () => {
	test("Friday returns current week Mon-Fri", () => {
		const friday = new Date("2025-02-28T16:00:00"); // Friday 4pm
		const boundary = getWeekBoundary(friday);

		expect(boundary.dateStrings).toEqual([
			"2025-02-24",
			"2025-02-25",
			"2025-02-26",
			"2025-02-27",
			"2025-02-28",
		]);
	});

	test("Monday returns previous week Mon-Fri", () => {
		const monday = new Date("2025-03-03T09:00:00"); // Monday 9am
		const boundary = getWeekBoundary(monday);

		expect(boundary.dateStrings).toEqual([
			"2025-02-24",
			"2025-02-25",
			"2025-02-26",
			"2025-02-27",
			"2025-02-28",
		]);
	});

	test("Wednesday returns current week", () => {
		const wednesday = new Date("2025-02-26T12:00:00");
		const boundary = getWeekBoundary(wednesday);

		expect(boundary.dateStrings[0]).toBe("2025-02-24"); // Monday
	});

	test("Sunday returns current week (considers Sunday as end of previous)", () => {
		const sunday = new Date("2025-03-02T12:00:00"); // Sunday
		const boundary = getWeekBoundary(sunday);

		// Sunday is day 0, so daysFromMonday = 6
		// This returns the week starting Feb 24
		expect(boundary.dateStrings[0]).toBe("2025-02-24");
	});

	test("Saturday returns current week", () => {
		const saturday = new Date("2025-03-01T12:00:00"); // Saturday
		const boundary = getWeekBoundary(saturday);

		expect(boundary.dateStrings[0]).toBe("2025-02-24");
	});

	test("start and end dates are correct", () => {
		const friday = new Date("2025-02-28T16:00:00");
		const boundary = getWeekBoundary(friday);

		// Start should be Monday 00:00
		expect(boundary.start.getDay()).toBe(1); // Monday
		expect(boundary.start.getHours()).toBe(0);
		expect(boundary.start.getMinutes()).toBe(0);

		// End should be Friday 23:59
		expect(boundary.end.getDay()).toBe(5); // Friday
		expect(boundary.end.getHours()).toBe(23);
		expect(boundary.end.getMinutes()).toBe(59);
	});
});

describe("getWeekBoundary timezone handling", () => {
	test("handles timezone where server and team differ", () => {
		// Scenario: Server in UTC, team in US Pacific
		// Friday at 23:00 UTC = Friday 3pm Pacific = still Friday
		const utcFriday = new Date("2025-02-28T23:00:00Z");
		const boundary = getWeekBoundary(utcFriday, "America/Los_Angeles");

		// Should return current week Mon-Fri
		expect(boundary.dateStrings[0]).toBe("2025-02-24"); // Monday
		expect(boundary.dateStrings[4]).toBe("2025-02-28"); // Friday
	});

	test("handles timezone crossing midnight", () => {
		// Saturday at 01:00 UTC = Friday 5pm Pacific (still Friday!)
		const utcSaturday = new Date("2025-03-01T01:00:00Z");
		const boundary = getWeekBoundary(utcSaturday, "America/Los_Angeles");

		// In Pacific time it's still Friday, so current week
		expect(boundary.dateStrings[0]).toBe("2025-02-24"); // Monday
		expect(boundary.dateStrings[4]).toBe("2025-02-28"); // Friday
	});

	test("handles Monday in different timezone", () => {
		// Monday at 05:00 UTC = Sunday 9pm Pacific (still Sunday!)
		const utcMonday = new Date("2025-03-03T05:00:00Z");
		const boundary = getWeekBoundary(utcMonday, "America/Los_Angeles");

		// In Pacific time it's Sunday, so report on current week (not previous)
		// Sunday uses "current week" logic
		expect(boundary.dateStrings[0]).toBe("2025-02-24"); // Monday of that week
	});
});

describe("calculateBlockerAgeDays", () => {
	test("calculates correct age", () => {
		const now = new Date("2025-02-28T16:00:00");
		const detected = "2025-02-21T10:00:00Z"; // 7 days ago

		expect(calculateBlockerAgeDays(detected, now)).toBe(7);
	});

	test("same day returns 0", () => {
		const now = new Date("2025-02-28T16:00:00");
		const detected = "2025-02-28T08:00:00Z";

		expect(calculateBlockerAgeDays(detected, now)).toBe(0);
	});

	test("partial day returns 0", () => {
		const now = new Date("2025-02-28T16:00:00");
		const detected = "2025-02-28T00:00:00Z"; // Same day, earlier

		expect(calculateBlockerAgeDays(detected, now)).toBe(0);
	});

	test("1.5 days rounds down to 1", () => {
		const now = new Date("2025-02-28T12:00:00");
		const detected = "2025-02-27T00:00:00Z"; // 1.5 days ago

		expect(calculateBlockerAgeDays(detected, now)).toBe(1);
	});
});

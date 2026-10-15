import {describe, expect, it} from "vitest";
import {isWorkspaceDisabledError} from "../lib/request/error-classification.js";

describe("workspace error classification on untrusted text", () => {
	it("rejects repeated near-matches without blocking classification", () => {
		const body = "workspace ".repeat(20_000) + "no longer ".repeat(20_000);
		expect(isWorkspaceDisabledError(403, "", body)).toBe(false);
		expect(isWorkspaceDisabledError(403, "", body + "available")).toBe(true);
	});

	it.each([
		["workspace is disabled", true],
		["organization is inactive", true],
		["org is no longer valid", true],
		["workspace subscription has expired", true],
		["org has been closed", true],
		["account has\nbeen\ndisabled", true],
		["workspace\ndisabled", false],
		["org\rno longer available", false],
		["workspace\u2028disabled", false],
		["workspace\u2029disabled", false],
		["disabled workspace", false],
		["no longer active org", false],
		["workspace no longer pending. org available", true],
		["org available. workspace no longer pending", false],
	] as const)("preserves phrase ordering and line boundaries: %s", (body, disabled) => {
		expect(isWorkspaceDisabledError(403, "", body)).toBe(disabled);
	});
});

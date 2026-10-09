import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const projectRoot = resolve(process.cwd());
interface Step { run?: string; uses?: string; if?: string; with?: Record<string, string> }
interface Job { steps: Step[]; "runs-on": string; needs?: string; if?: string }
interface Workflow { on: Record<string, unknown>; jobs: Record<string, Job>; concurrency: {group: string; "cancel-in-progress": boolean} }
function workflow(): Workflow {
	return parse(readFileSync(join(projectRoot, ".github/workflows/ci.yml"), "utf8"));
}

describe("CI workflow parity", () => {
	it("covers push and PR in one workflow", () => {
		expect(existsSync(join(projectRoot, ".github/workflows/pr-ci.yml"))).toBe(false);
		expect(Object.keys(workflow().on)).toEqual(expect.arrayContaining(["push", "pull_request"]));
	});
	it("includes an unconditional Windows script-checking job", () => {
		const windows = workflow().jobs["scripts-windows"]!;
		expect(windows["runs-on"]).toBe("windows-latest");
		expect(windows.if).toBeUndefined();
	});
	it("cancels stale runs within their PR or branch", () => {
		expect(workflow().concurrency).toEqual({group: "ci-${{ github.event.pull_request.number || github.ref }}", "cancel-in-progress": true});
	});
	it("selects PR validation only for pull requests", () => {
		const validation = workflow().jobs.validate!;
		expect(validation.if).toBe("github.event_name == 'pull_request'");
	});
	it("typechecks scripts in an isolated checkout without generated dist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "script-check-"));
		try {
			for (const path of ["scripts", "lib", "vendor", "index.ts", "package.json", "tsconfig.json", "tsconfig.scripts.json"]) {
				await cp(join(projectRoot, path), join(dir, path), {recursive: true});
			}
			await symlink(join(projectRoot, "node_modules"), join(dir, "node_modules"), "junction");
			expect(existsSync(join(dir, "dist"))).toBe(false);
			execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "typecheck:scripts"], {cwd: dir, timeout: 30000, stdio: "pipe", shell: process.platform === "win32"});
			expect(existsSync(join(dir, "dist"))).toBe(false);
		} finally { await removeWithRetry(dir, {recursive: true, force: true}); }
	}, 35000);
	it("connects the package artifact to an isolated Node 22 smoke job", () => {
		const ci = workflow(), builder = ci.jobs["build-package"]!, smoke = ci.jobs["node22-smoke"]!;
		expect(builder.steps.some(step => step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
		expect(smoke.needs).toBe("build-package");
		expect(smoke.steps.find(step => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"]).toBe("22.19.x");
		expect(smoke.steps.some(step => step.uses?.startsWith("actions/download-artifact@"))).toBe(true);
		expect(smoke.steps.some(step => step.uses?.startsWith("actions/checkout@"))).toBe(false);
	});
});

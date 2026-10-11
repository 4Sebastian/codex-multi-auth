import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const projectRoot = resolve(process.cwd());
interface Step { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string> }
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
	it("executes the packaged CLI smoke commands in an isolated consumer on the current runtime", async () => {
		const smoke = workflow().jobs["node22-smoke"]!;
		expect(smoke.needs).toBe("build-package");
		expect(smoke.steps.find(step => step.uses?.startsWith("actions/setup-node@"))?.with?.["node-version"]).toBe("22.19.x");
		const commands = smoke.steps.find(step => step.name === "Smoke-run CLI entrypoints")?.run;
		if (!commands) throw Error("Missing executable package smoke step");
		const root = await mkdtemp(join(tmpdir(), "package-smoke-"));
		const source = join(root, "source"), prefix = join(root, "consumer"), home = join(root, "home");
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const env = {...process.env, CI: "1", HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), CODEX_MULTI_AUTH_DIR: join(home, "multi-auth")};
		try {
			await mkdir(source); await mkdir(home); await mkdir(prefix);
			for (const path of ["scripts", "lib", "vendor", "index.ts", "package.json", "tsconfig.json", "assets", "config", "skills", ".codex-plugin", "README.md", "LICENSE"]) {
				await cp(join(projectRoot, path), join(source, path), {recursive: true});
			}
			await symlink(join(projectRoot, "node_modules"), join(source, "node_modules"), "junction");
			execFileSync(process.execPath, [join(projectRoot, "node_modules/tsgo/bin/tsc"), "-p", join(source, "tsconfig.json")], {cwd: source, env, timeout: 30000, stdio: "inherit"});
			execFileSync(process.execPath, [join(source, "scripts/copy-oauth-success.js")], {cwd: source, env, timeout: 5000});
			execFileSync(npm, ["pack", "--ignore-scripts"], {cwd: source, env, timeout: 15000, stdio: "pipe", shell: process.platform === "win32"});
			const artifacts = (await readdir(source)).filter(name => name.endsWith(".tgz"));
			expect(artifacts).toHaveLength(1);
			execFileSync("tar", ["-xzf", join(source, artifacts[0]!), "-C", prefix], {cwd: prefix, env, timeout: 10000});
			const installed = join(prefix, "package");
			const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
			for (const dependency of Object.keys(metadata.dependencies).filter(name => !metadata.bundleDependencies.includes(name))) {
				await cp(join(projectRoot, "node_modules", dependency), join(installed, "node_modules", dependency), {recursive: true});
			}
			const bin = join(prefix, "bin"), entry = join(installed, metadata.bin["codex-multi-auth"]);
			await mkdir(bin);
			if (process.platform === "win32") await writeFile(join(bin, "codex-multi-auth.cmd"), `@"${process.execPath}" "${entry}" %*\r\n`);
			else await symlink(entry, join(bin, "codex-multi-auth"));
			const output = execFileSync(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", commands] : ["-eu", "-c", commands], {cwd: prefix, env: {...env, PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`}, timeout: 10000}).toString();
			const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
			expect(output).toContain(manifest.version);
			expect(output).toContain("Codex Multi-Auth CLI");
			const exports = execFileSync(process.execPath, ["--input-type=module", "--eval", `import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; const require = createRequire(${JSON.stringify(join(installed, "package.json"))}); const pkg = require('codex-multi-auth/package.json'); for (const key of Object.keys(pkg.exports).filter(key => key !== './package.json')) { const path = require.resolve('codex-multi-auth' + (key === '.' ? '' : key.slice(1))); await import(pathToFileURL(path).href); } console.log(pkg.version);`], {cwd: prefix, env, timeout: 10000}).toString();
			expect(exports.trim()).toBe(manifest.version);
			expect(await readFile(join(installed, "dist/lib/oauth-success.html"))).toEqual(await readFile(join(source, "lib/oauth-success.html")));
		} finally {await removeWithRetry(root, {recursive: true, force: true});}
	}, 90000);
});

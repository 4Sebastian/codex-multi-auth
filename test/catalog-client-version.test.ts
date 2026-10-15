import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRealCodexBin } from "../scripts/codex-bin-resolver.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { resolveCatalogClientVersion } from "../lib/runtime/catalog-client-version.js";

describe("catalog client version", () => {
	it.each(["js", "mjs", "cjs"])("executes a real %s entry through Node with only --version", async extension => {
		const dir = await fs.mkdtemp(join(tmpdir(), "catalog-version-"));
		const entry = join(dir, `codex.${extension}`), argumentsPath = join(dir, "arguments.json");
		await fs.writeFile(entry, `${extension === "cjs" ? 'const fs = require("node:fs")' : 'import fs from "node:fs"'}; fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2))); console.log("codex-cli 0.170.0");`);
		vi.stubEnv("CODEX_MULTI_AUTH_REAL_CODEX_BIN", entry);
		try {
			expect(await resolveCatalogClientVersion()).toBe("0.170.0");
			expect(JSON.parse(await fs.readFile(argumentsPath, "utf8"))).toEqual(["--version"]);
		} finally {vi.unstubAllEnvs(); await removeWithRetry(dir, {recursive: true, force: true});}
	});
	it.each(["overflow", "invalid", "unavailable"])("falls back safely after actual executable %s", async mode => {
		const dir = await fs.mkdtemp(join(tmpdir(), "catalog-version-"));
		const entry = join(dir, "codex.mjs");
		if (mode !== "unavailable") await fs.writeFile(entry, `console.log(${JSON.stringify(mode === "overflow" ? "codex-cli 0.170.0" + " ".repeat(5000) : "invalid fixture output")});`);
		vi.stubEnv("CODEX_MULTI_AUTH_REAL_CODEX_BIN", entry);
		try {expect(await resolveCatalogClientVersion()).toBe("0.0.0");}
		finally {vi.unstubAllEnvs(); await removeWithRetry(dir, {recursive: true, force: true});}
	});
	it.each(["\\bin\\codex.exe", "C:codex.exe"])("rejects ambiguous Windows executable override %s", override => {
		expect(resolveRealCodexBin({platform: "win32", env: {CODEX_MULTI_AUTH_REAL_CODEX_BIN: override}, existsSyncImpl: () => true})).toBeNull();
	});
	it.each(["C:\\tools\\codex.cmd", "\\\\server\\share\\codex.ps1"])("resolves the Windows npm shim %s to its Node entry", override => {
		const resolved = resolveRealCodexBin({platform: "win32", env: {CODEX_MULTI_AUTH_REAL_CODEX_BIN: override}, existsSyncImpl: () => true});
		expect(resolved?.launchWithNode).toBe(true);
		expect(resolved?.path).toBe(override.startsWith("C:") ? "C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js" : "\\\\server\\share\\node_modules\\@openai\\codex\\bin\\codex.js");
	});
	it("preserves an explicit valid client version without running Codex", async () => {
		const readVersion = vi.fn();
		expect(await resolveCatalogClientVersion("0.161.0-alpha.1", readVersion)).toBe("0.161.0-alpha.1");
		expect(readVersion).not.toHaveBeenCalled();
	});
	it.each([undefined, "", "bad version", "x".repeat(81)])("uses the installed CLI for missing or invalid version %s", async version => {
		expect(await resolveCatalogClientVersion(version, async () => "codex-cli 0.160.0\n")).toBe("0.160.0");
	});
	it.each(["unexpected output", "codex-cli bad version", "codex-cli " + "1".repeat(81)])("uses a conservative version when CLI output is invalid", async output => {
		expect(await resolveCatalogClientVersion(undefined, async () => output)).toBe("0.0.0");
	});
	it("still supplies the required parameter when Codex is unavailable", async () => {
		expect(await resolveCatalogClientVersion(undefined, async () => { throw Error("unavailable"); })).toBe("0.0.0");
	});
});

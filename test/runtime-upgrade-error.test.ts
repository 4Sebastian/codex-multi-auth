import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let directory: string;
let worker: string;

beforeAll(() => {
	directory = mkdtempSync(join(process.cwd(), ".tmp-upgrade-error-"));
	worker = join(directory, "worker.mjs");
	buildSync({
		entryPoints: ["test/fixtures/custom-upgrade-error.mjs"],
		outfile: worker,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	});
});

afterAll(async () => {
	if (directory) await removeWithRetry(directory, { recursive: true, force: true });
});

describe("custom upgrade socket errors", () => {
	it.each(["malformed", "unsupported", "unauthorized", "accept"].flatMap(
		scenario => ["EPIPE", "ECONNRESET"].map(code => ({ scenario, code })),
	))("survives $scenario $code and serves subsequent requests", ({ scenario, code }) => {
		const child = spawnSync(process.execPath, [worker, scenario, code], {
			env: process.env,
			timeout: 4000,
			maxBuffer: 64 * 1024,
			encoding: "utf8",
		});
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toBe("survived\n");
	});
});

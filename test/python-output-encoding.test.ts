import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("repository Python startup", () => {
	it("emits scanner-style Unicode when the inherited console encoding is Windows cp1252", () => {
		const installedPackageRoot = mkdtempSync(join(tmpdir(), "scanner-package-"));
		const installedPackage = join(installedPackageRoot, "codex_plugin_scanner");
		mkdirSync(installedPackage);
		writeFileSync(join(installedPackage, "__init__.py"), "");
		writeFileSync(
			join(installedPackage, "action_runner.py"),
			"import sys\nprint(sys.stdout.encoding)\nprint('🔗 scanner report')\n",
		);
		const output = execFileSync(
			"python3",
			["-m", "codex_plugin_scanner.action_runner"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					PYTHONIOENCODING: "cp1252",
					PYTHONPATH: installedPackageRoot,
				},
			},
		);

		expect(output).toBe("utf-8\n🔗 scanner report\n");
	});
});

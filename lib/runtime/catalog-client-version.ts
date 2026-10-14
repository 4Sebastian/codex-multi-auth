import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const versionPattern = /^[0-9A-Za-z.+_-]{1,80}$/;

async function readInstalledVersion(): Promise<string> {
	const override = process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN?.trim();
	let executable = "codex";
	let args: string[] = [];
	if (override) {
		if (!isAbsolute(override)) throw Error("Codex executable must be absolute");
		executable = override;
	} else {
		try {
			args = [createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js")];
			executable = process.execPath;
		} catch {
			// Standalone Codex installations expose their executable on PATH.
		}
	}
	const { stdout } = await promisify(execFile)(executable, [...args, "--version"], {
		timeout: 3000,
		maxBuffer: 4096,
		windowsHide: true,
	});
	return stdout;
}

/** The OAuth catalog requires a version and filters models by it. */
export async function resolveCatalogClientVersion(
	requested?: string,
	readVersion: () => Promise<string> = readInstalledVersion,
): Promise<string> {
	if (requested && versionPattern.test(requested)) return requested;
	try {
		const version = /^codex-cli ([0-9A-Za-z.+_-]+)\s*$/.exec((await readVersion()).trim())?.[1];
		if (version && versionPattern.test(version)) return version;
	} catch {
		// Discovery also works without an installed CLI, using the baseline catalog.
	}
	return "0.0.0";
}

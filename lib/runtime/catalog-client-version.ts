import { execFile, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const versionPattern = /^[0-9A-Za-z.+_-]{1,80}$/;

async function readInstalledVersion(): Promise<string> {
	const packageUrl = pathToFileURL(createRequire(import.meta.url).resolve("codex-multi-auth/package.json"));
	const resolverUrl = new URL("./scripts/codex-bin-resolver.js", packageUrl);
	const { resolveRealCodexBin }: {
		resolveRealCodexBin: (options: {spawnSyncImpl: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>}) => {path: string; launchWithNode: boolean} | null;
	} = await import(resolverUrl.href);
	const deadline = performance.now() + 3000;
	const resolved = resolveRealCodexBin({spawnSyncImpl: (command, args, options) => {
		const timeout = Math.ceil(deadline - performance.now());
		if (timeout <= 0) throw Error("Codex executable lookup timed out");
		return spawnSync(command, args, {...options, timeout, maxBuffer: 4096});
	}});
	if (!resolved || performance.now() >= deadline) throw Error("Codex executable unavailable");
	const executable = resolved.launchWithNode ? process.execPath : resolved.path;
	const args = resolved.launchWithNode ? [resolved.path, "--version"] : ["--version"];
	const { stdout } = await promisify(execFile)(executable, args, {
		timeout: Math.max(1, Math.ceil(deadline - performance.now())),
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

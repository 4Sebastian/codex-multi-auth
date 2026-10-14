import { describe, expect, it, vi } from "vitest";
import { resolveCatalogClientVersion } from "../lib/runtime/catalog-client-version.js";

describe("catalog client version", () => {
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

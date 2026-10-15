import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { syncCodexCliActiveSelectionIfDrifted } from "../lib/codex-manager/login-menu-data.js";
import { persistAndSyncSelectedAccount } from "../lib/codex-manager/persist-selected-account.js";
import { nativeRateLimitsRpc } from "../lib/runtime/native-rate-limits.js";
import {setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
vi.mock("../lib/storage.js", async importOriginal => ({...await importOriginal<typeof import("../lib/storage.js")>(), saveAccounts: vi.fn(async () => {})}));
const jwt = `h.${Buffer.from(JSON.stringify({sub: "fixture-user", exp: 4102444800, "https://api.openai.com/auth": {chatgpt_account_id: "native-default"}, "https://api.openai.com/profile": {email: "fixture@example.test"}})).toString("base64url")}.s`;
const fixture = (): AccountStorageV3 => ({version: 3, activeIndex: 0, activeIndexByFamily: {}, accounts: [{accountId: "refused-binding", accountIdSource: "manual", email: "fixture@example.test", accessToken: jwt, refreshToken: "fixture-refresh", expiresAt: 4102444800000, addedAt: 1, lastUsed: 1, codexCliMirror: {forAccountId: "refused-binding", accountId: "native-default"}}]});
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "writer-callers-"));
	vi.stubEnv("CODEX_CLI_AUTH_PATH", join(dir, "auth.json"));
	vi.stubEnv("CODEX_CLI_ACCOUNTS_PATH", join(dir, "accounts.json"));
	vi.stubEnv("CODEX_CLI_CONFIG_PATH", join(dir, "config.toml"));
	vi.stubEnv("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
	vi.stubEnv("CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE", "0");
	clearCodexCliStateCache();
	setStoragePathDirect(join(dir, "pool.json"));
	await writeFile(join(dir, "pool.json"), JSON.stringify(fixture()));
});
afterEach(async () => {
	clearCodexCliStateCache();
	vi.unstubAllEnvs();
	setStoragePathDirect(null);
	await removeWithRetry(dir, {recursive: true, force: true});
});
async function writtenAccount() { return JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).tokens.account_id; }
describe("Codex auth.json writer callers", () => {
	it("writes the mirror identity from runtime account selection", async () => {
		await new AccountManager(undefined, fixture()).syncCodexCliActiveSelectionForIndex(0);
		expect(await writtenAccount()).toBe("native-default");
	});
	it("writes the mirror identity when the login menu repairs drift", async () => {
		await writeFile(join(dir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: jwt, refresh_token: "fixture-refresh", account_id: "org-refused-binding"}}));
		expect(await syncCodexCliActiveSelectionIfDrifted(fixture())).toBe(true);
		expect(await writtenAccount()).toBe("native-default");
		expect(await syncCodexCliActiveSelectionIfDrifted(fixture())).toBe(false);
	});
	it("writes the mirror identity after a managed account switch", async () => {
		await persistAndSyncSelectedAccount({storage: fixture(), targetIndex: 0, parsed: 1, switchReason: "manual"});
		expect(await writtenAccount()).toBe("native-default");
	});
	it("writes the mirror identity into an isolated native RPC home", async () => {
		const script = join(dir, "rpc.mjs"), seen = join(dir, "seen.json");
		await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';writeFileSync(${JSON.stringify(seen)},readFileSync(process.env.CODEX_HOME+'/auth.json'));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:{}}));});`);
		const account = fixture().accounts[0]!;
		await nativeRateLimitsRpc({accessToken: jwt, expiresAt: account.expiresAt!, accountId: account.accountId!, codexCliMirror: account.codexCliMirror}, "account/rateLimits/read", {}, {command: [process.execPath, script], tempRoot: dir});
		expect(JSON.parse(await readFile(seen, "utf8")).tokens.account_id).toBe("native-default");
	});
});

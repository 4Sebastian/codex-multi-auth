import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
	discoverModelInventory as discoverManagedModelInventory,
	formatModelInventory,
} from "../lib/runtime/model-discovery-status.js";
import { promises as isolationFs } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
import type {ApiRouteCredential} from "../lib/api-route-store.js";
import {existsSync} from 'node:fs';
import {writeAccountSourceFixture} from './helpers/account-source-fixture.js';
import {getStoragePath,setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import * as tokenRefresh from "../lib/runtime/rotation-token-refresh.js";
import * as catalogVersion from "../lib/runtime/catalog-client-version.js";
import {getPendingAuthPath} from "../lib/storage/pending-auth.js";
// Inventory writes merge with whatever is already on disk, so every test gets
// its own multi-auth directory instead of the worker's shared one.
function discoverModelInventory(...args:Parameters<typeof discoverManagedModelInventory>){
 if(args[0]&&!existsSync(getStoragePath()))writeAccountSourceFixture(args[0]);
 return discoverManagedModelInventory(...args);
}
let previousMultiAuthDir: string | undefined;
let multiAuthDir: string;
beforeEach(async () => {
	vi.spyOn(catalogVersion, "resolveCatalogClientVersion").mockImplementation(async requested => requested ?? "0.160.0");
	previousMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
	multiAuthDir = await isolationFs.mkdtemp(isolationJoin(isolationTmpdir(), "model-discovery-"));
	process.env.CODEX_MULTI_AUTH_DIR = multiAuthDir;
 setStoragePathDirect(isolationJoin(multiAuthDir,'accounts.json'));
});
afterEach(async () => {
	vi.restoreAllMocks();
	setStoragePathDirect(null);
	if (previousMultiAuthDir === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
	else process.env.CODEX_MULTI_AUTH_DIR = previousMultiAuthDir;
	await isolationFs.rm(multiAuthDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
it.each(['api','write'].flatMap(stage=>['disabled','deleted','code-only','zero','expiry','credential','workspace','journal','reset','metadata'].map(mutation=>({stage,mutation}))))('retains original OAuth authority through final export and publication (%j)',async({stage,mutation})=>{
 const {saveModelInventory}=await import('../lib/runtime/model-discovery-status.js');
 const storage:AccountStorageV3={version:3,activeIndex:0,accounts:[
  {recordId:'A',accountId:'W1',accessToken:'catalog-A',refreshToken:'refresh-A',expiresAt:Date.now()+3600000,addedAt:1,lastUsed:1,workspaces:[{id:'W1',enabled:true}]},
  {recordId:'B',accountId:'W2',accessToken:'catalog-B',refreshToken:'refresh-B',expiresAt:Date.now()+3600000,addedAt:2,lastUsed:2}
 ]};
 const path=isolationJoin(multiAuthDir,'accounts.json');setStoragePathDirect(path);await isolationFs.writeFile(path,JSON.stringify(storage));
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const fetcher:typeof fetch=async(_input,init)=>{
  const auth=new Headers(init?.headers).get('authorization');
  if(auth==='Bearer catalog-api'){if(stage==='api'){entered();await gate;}return Response.json({data:[{id:'independent-api'}]});}
  return Response.json({models:[{slug:auth==='Bearer catalog-A'?'observed-A':'independent-B'}]});
 };
 const options={clientVersion:'0.160.0',fetchImpl:fetcher};
 let pending:Promise<unknown>;
 let inventory:Awaited<ReturnType<typeof discoverModelInventory>>|undefined;
 if(stage==='api')pending=discoverModelInventory(storage,[{id:'api',kind:'api',label:'Fixture API',enabled:true,priority:0,apiKey:'catalog-api',probeCapabilities:false,visibleModels:['independent-api']}],options).then(value=>{inventory=value;});
 else{
  inventory=await discoverModelInventory(storage,[],options);
  expect(inventory.entries[0]?.visibleModels).toEqual(['observed-A']);
  const write=isolationFs.writeFile.bind(isolationFs);
  vi.spyOn(isolationFs,'writeFile').mockImplementation(async(...args)=>{await write(...args);if(String(args[0]).includes('model-discovery.json.')&&!String(args[0]).endsWith('.lock')){entered();await gate;}});
  pending=saveModelInventory(inventory);
 }
 await ready;
 try{
  const row=storage.accounts[0]!;
  if(mutation==='disabled')row.enabled=false;
  if(mutation==='deleted')storage.accounts.shift();
  if(mutation==='code-only')row.authInvalidationErrorCode='token_invalidated';
  if(mutation==='zero')row.authInvalidatedAt=0;
  if(mutation==='expiry')row.expiresAt!+=1;
  if(mutation==='credential')Object.assign(row,{accessToken:'replacement-A',refreshToken:'replacement-refresh'});
  if(mutation==='workspace')row.workspaces![0]={id:'replacement-workspace',enabled:true};
  if(mutation==='metadata')row.lastUsed+=1;
  await isolationFs.writeFile(path,JSON.stringify(storage));
  if(mutation==='journal')await isolationFs.writeFile(getPendingAuthPath(path),'malformed fixture journal');
  if(mutation==='reset')await isolationFs.writeFile(path+'.reset-intent','{}');
  release();await pending;
  if(!inventory)throw Error('Missing discovered inventory');
  if(stage==='api')await saveModelInventory(inventory);
  const artifact=JSON.parse(await isolationFs.readFile(isolationJoin(multiAuthDir,'model-discovery.json'),'utf8'));
  for(const rows of [inventory.entries,artifact.entries]){
   const a=rows[0];
   expect(a).toMatchObject(mutation==='metadata'?{routable:true,visibleModels:['observed-A']}:{routable:false,visibleModels:[],models:['observed-A']});
   const b=rows[1];expect(b.visibleModels).toEqual(['journal','reset','zero'].includes(mutation)?[]:['independent-B']);
  }
  expect(JSON.stringify(artifact)).not.toMatch(/catalog-A|refresh-A|replacement-A|catalog-api/);
 }finally{release();await pending;}
});

it.each(["invalidated", "code-only", "zero", "negative", "cooldown", "quota"])("does not submit initially restricted OAuth discovery (%s)", async restriction => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "R1", accountId: "W1", accessToken: "fixture-A", refreshToken: "fixture-refresh-A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
	const account = storage.accounts[0]!;
	if (restriction === "invalidated") account.authInvalidatedAt = Date.now();
	if (["code-only", "zero", "negative"].includes(restriction)) {
		account.authInvalidationErrorCode = "token_invalidated";
		if (restriction !== "code-only") account.authInvalidatedAt = restriction === "zero" ? 0 : -1;
	}
	if (restriction === "cooldown") Object.assign(account, {coolingDownUntil: Date.now() + 60000, cooldownReason: "auth-failure"});
	if (restriction === "quota") account.rateLimitResetTimes = {codex: Date.now() + 60000};
	const path = isolationJoin(multiAuthDir, "accounts.json");
	setStoragePathDirect(path); await isolationFs.writeFile(path, JSON.stringify(storage));
	const fetcher = vi.fn(async () => Response.json({models: [{slug: "fixture"}]}));
	const inventory = await discoverModelInventory(storage, [], {fetchImpl: fetcher});
	expect(fetcher).not.toHaveBeenCalled();
	expect(inventory.entries[0]).toMatchObject({error: true, models: [], visibleModels: []});
});

it.each(["disabled", "deleted", "invalidated", "credential", "workspace", "journal", "reset"])("rechecks OAuth discovery authority after refresh (%s)", async mutation => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{recordId: "R1", accountId: "W1", accessToken: "fixture-A", refreshToken: "fixture-refresh-A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{id: "W1", enabled: true}]}]};
	const path = isolationJoin(multiAuthDir, "accounts.json");
	setStoragePathDirect(path); await isolationFs.writeFile(path, JSON.stringify(storage));
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const refresh = tokenRefresh.ensureFreshAccessToken;
	vi.spyOn(tokenRefresh, "ensureFreshAccessToken").mockImplementation(async args => {const result = await refresh(args); entered(); await gate; return result;});
	const fetcher = vi.fn(async () => Response.json({models: [{slug: "fixture"}]}));
	const pending = discoverModelInventory(storage, [], {fetchImpl: fetcher});
	await ready;
	try {
		if (mutation === "disabled") storage.accounts[0]!.enabled = false;
		if (mutation === "deleted") storage.accounts = [];
		if (mutation === "invalidated") storage.accounts[0]!.authInvalidatedAt = Date.now();
		if (mutation === "credential") Object.assign(storage.accounts[0]!, {accessToken: "fixture-B", refreshToken: "fixture-refresh-B"});
		if (mutation === "workspace") storage.accounts[0]!.workspaces![0]!.enabled = false;
		if (mutation === "reset") await isolationFs.writeFile(`${path}.reset-intent`, "{}");
		if (mutation === "journal") await isolationFs.writeFile(getPendingAuthPath(path), "fixture corrupt journal");
		else await isolationFs.writeFile(path, JSON.stringify(storage));
		release();
		const inventory = await pending;
		expect(fetcher).not.toHaveBeenCalled();
		expect(inventory.entries[0]).toMatchObject({error: true, models: [], visibleModels: []});
	} finally {release(); await pending;}
});

it.each(["disabled", "deleted", "code-only", "expiry", "credential", "workspace", "journal", "reset", "metadata"])("rejects stale OAuth catalog publication after body reading (%s)", async mutation => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [
		{recordId: "R1", accountId: "W1", accessToken: "fixture-A", refreshToken: "fixture-refresh-A", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{id: "W1", enabled: true}]},
		{recordId: "R2", accountId: "W2", accessToken: "fixture-B", refreshToken: "fixture-refresh-B", expiresAt: Date.now() + 3600000, addedAt: 2, lastUsed: 2},
	]};
	const path = isolationJoin(multiAuthDir, "accounts.json");
	setStoragePathDirect(path); await isolationFs.writeFile(path, JSON.stringify(storage));
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
	let bodies = 0;
	const fetcher = vi.fn(async (_url, init) => {
		const first = new Headers(init?.headers).get("chatgpt-account-id") === "W1";
		return new Response(new ReadableStream({async start(controller) {
			if (++bodies === 2) entered();
			await gate;
			controller.enqueue(new TextEncoder().encode(JSON.stringify({models: [{slug: first ? "stale-A" : "independent-B"}]}))); controller.close();
		}}), {headers: {"content-type": "application/json"}});
	});
	const pending = discoverModelInventory(storage, [], {fetchImpl: fetcher});
	await ready;
	try {
		const row = storage.accounts[0]!;
		if (mutation === "disabled") row.enabled = false;
		if (mutation === "deleted") storage.accounts.shift();
		if (mutation === "code-only") row.authInvalidationErrorCode = "token_invalidated";
		if (mutation === "expiry") row.expiresAt! += 1000;
		if (mutation === "credential") Object.assign(row, {accessToken: "replacement-A", refreshToken: "replacement-refresh"});
		if (mutation === "workspace") row.workspaces![0]!.enabled = false;
		if (mutation === "metadata") row.lastUsed += 1;
		if (mutation === "reset") await isolationFs.writeFile(`${path}.reset-intent`, "{}");
		if (mutation === "journal") await isolationFs.writeFile(getPendingAuthPath(path), "invalid journal");
		else await isolationFs.writeFile(path, JSON.stringify(storage));
		release();
		const inventory = await pending;
		expect(inventory.entries[0]?.visibleModels).toEqual(mutation === "metadata" ? ["stale-A"] : []);
		expect(inventory.entries[0]?.error).toBe(mutation !== "metadata");
		if (!["reset", "journal", "code-only"].includes(mutation)) {
			expect(inventory.entries[1]?.visibleModels).toEqual(["independent-B"]);
			expect(fetcher).toHaveBeenCalledTimes(2);
		}
		expect(fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).get("chatgpt-account-id") === "W1")).toHaveLength(1);
		expect(fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).get("chatgpt-account-id") === "W2").length).toBeLessThanOrEqual(1);
	} finally {release(); await pending;}
});

it("discovers OAuth catalogs on a first check without a previously stored client version", async () => {
	const storage: AccountStorageV3 = {version: 3, activeIndex: 0, accounts: [{accountId: "fixture-account", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1}]};
	const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		expect(init?.method ?? "GET").toBe("GET");
		return new URL(String(input)).searchParams.has("client_version")
			? Response.json({models: [{slug: "fixture-model"}]})
			: Response.json({error: {message: "client_version required"}}, {status: 400});
	});
	const inventory = await discoverModelInventory(storage, [], {fetchImpl: fetcher});
	expect(inventory.entries[0]).toMatchObject({error: false, models: ["fixture-model"]});
	expect(inventory.clientVersion).toBe("0.160.0");
	expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("model discovery reporting", () => {
	it("reports each credential independently including API-only and hidden IDs", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ data: [{ id: "exclusive" }, { id: "hidden" }] }),
		);
		const inventory = await discoverModelInventory(
			null,
			[
				{
					id: "fixture",
					label: "API fixture",
					kind: "zdr",
					apiKey: "fixture-secret",
					enabled: true,
					priority: 0,
					visibleModels: ["exclusive"],
				},
			],
			{ fetchImpl: fetcher as typeof fetch, now: () => 1234 },
		);
		expect(inventory.entries[0]).toMatchObject({
			kind: "zdr",
			models: ["exclusive", "hidden"],
			visibleModels: ["exclusive"],
			checkedAt: 1234,
			error: false,
		});
		expect(JSON.stringify(inventory)).not.toContain("fixture-secret");
		expect(formatModelInventory(inventory, 70000).join("\n")).toContain(
			"stale",
		);
	});
	it("shows discovery failures and never advertises guessed availability", async () => {
		const result = await discoverModelInventory(
			null,
			[
				{
					id: "fixture",
					label: "API fixture",
					kind: "api",
					apiKey: "fixture-secret",
					enabled: true,
					priority: 0,
					visibleModels: ["exclusive"],
				},
			],
			{
				fetchImpl: vi.fn(
					async () => new Response("bad", { status: 401 }),
				) as typeof fetch,
			},
		);
		expect(result.entries[0]).toMatchObject({ error: true, models: [] });
		expect(formatModelInventory(result).join("\n")).toContain(
			"discovery failed",
		);
	});
});

it("reports per-model speed, reasoning and advertised access programs without private instructions", async () => {
	const storage = {
		version: 3 as const,
		activeIndex: 0,
		activeIndexByFamily: {},
		accounts: [
			{
				accountId: "fixture-account",
				refreshToken: "fixture-refresh",
				accessToken: "fixture-access",
				expiresAt: Date.now() + 3600000,
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
	const inventory = await discoverModelInventory(storage, [], {
		fetchImpl: vi.fn(async () =>
			Response.json({
				models: [
					{
						slug: "fixture-model",
						service_tiers: [
							{
								id: "accelerated",
								name: "Accelerated",
								description: "Fixture speed",
							},
						],
						supported_reasoning_levels: [{ effort: "high" }],
						available_access_programs: { research: ["preview"] },
						model_messages: { instructions_template: "private-instructions" },
					},
				],
			}),
		) as typeof fetch,
	});
	const output = formatModelInventory(inventory).join("\n");
	expect(output).toContain("Accelerated");
	expect(output).toContain("high");
	expect(output).toContain("research:preview");
	expect(JSON.stringify(inventory)).not.toContain("private-instructions");
});

it("refreshes the running native proxy with the installed version instead of a stale inventory version", async () => {
	const { refreshAndPrintModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const inventory = {
		version: 1 as const,
		checkedAt: 200,
		clientVersion: "1.2.3",
		entries: [],
	};
	const load = vi
		.fn()
		.mockResolvedValueOnce({ ...inventory, checkedAt: 1 })
		.mockResolvedValueOnce(inventory);
	const fetcher = vi.fn(async () =>
		Response.json({ models: [{ slug: "fixture" }] }),
	);
	const log = vi.fn();
	await refreshAndPrintModelInventory(log, {
		getBinding: async () => ({
			running: true,
			state: {
				nativeOpenai: true,
				baseUrl: "http://127.0.0.1:12345",
				clientApiKey: "fixture-token",
			},
		}),
		fetchImpl: fetcher as typeof fetch,
		loadInventory: load,
		now: () => 100,
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(String(fetcher.mock.calls[0]?.[0])).toBe(
		"http://127.0.0.1:12345/models?refresh_capabilities=1&client_version=0.160.0",
	);
	expect(
		new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
	).toBe("Bearer fixture-token");
	expect(log.mock.calls.flat().join("\n")).toContain(
		"Running proxy model catalog refreshed",
	);
});
it.each(["https://remote.invalid", "http://127.0.0.1:12345/redirect"])(
	"never sends the local binding secret to an invalid refresh target %s",
	async (baseUrl) => {
		const { refreshAndPrintModelInventory } = await import(
			"../lib/runtime/model-discovery-status.js"
		);
		const fetcher = vi.fn();
		const log = vi.fn();
		await refreshAndPrintModelInventory(log, {
			getBinding: async () => ({
				running: true,
				state: { nativeOpenai: true, baseUrl, clientApiKey: "fixture-token" },
			}),
			fetchImpl: fetcher,
			loadInventory: async () => null,
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toContain("failed");
	},
);

it("serializes status writes so a slow older snapshot cannot replace fresh probe results", async () => {
	const { promises: fs } = await import("node:fs");
	const { saveModelInventory, loadModelInventory } = await import(
		"../lib/runtime/model-discovery-status.js"
	);
	const original = fs.writeFile.bind(fs);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		if (String(args[1]).includes('"checkedAt":1,')) {
			entered();
			await gate;
		}
		return original(...args);
	});
	try {
		const older = saveModelInventory({ version: 1, checkedAt: 1, entries: [] });
		await started;
		const newer = saveModelInventory({ version: 1, checkedAt: 2, entries: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();
		await Promise.all([older, newer]);
		expect((await loadModelInventory())?.checkedAt).toBe(2);
	} finally {
		release();
		spy.mockRestore();
	}
});

it("discovers each enabled workspace independently without changing the stored binding", async () => {
 const storage = { version: 3 as const, activeIndex: 0, accounts: [{
  recordId: "fixture-record", accountId: "primary", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now()+3600000, addedAt: 1, lastUsed: 1,
  currentWorkspaceIndex: 1, workspaces: [{id:"primary",enabled:true},{id:"secondary",enabled:true},{id:"disabled",enabled:false}],
 }] };
 const seen: string[] = [];
 const inventory = await discoverModelInventory(storage, [], {fetchImpl: (async (_url, init) => {
  const id = new Headers(init?.headers).get("chatgpt-account-id")!; seen.push(id);
  return Response.json({models:[{slug:`model-${id}`} ]});
 }) as typeof fetch});
 expect(seen.sort()).toEqual(["primary","secondary"]);
 expect(inventory.entries).toHaveLength(3);
 expect(inventory.entries[0]).toMatchObject({models:["model-primary"],routable:true});
 expect(inventory.entries[1]).toMatchObject({models:["model-secondary"],routable:true});
 expect(inventory.entries[2]).toMatchObject({enabled:false,models:[]});
 expect(storage.accounts[0].accountId).toBe("primary");
 expect(storage.accounts[0].currentWorkspaceIndex).toBe(1);
 expect(JSON.stringify(inventory)).not.toContain("fixture-access");
});

it("highlights changes by stable scope and never treats failed discovery as lost access", async () => {
 const { withInventoryChanges } = await import("../lib/runtime/model-discovery-status.js");
 const entry = {id:"scope",label:"Account 1",kind:"oauth" as const,enabled:true,error:false,checkedAt:1,models:["shared"],visibleModels:["shared"],entitlements:[{model:"shared",serviceTiers:[],reasoningLevels:["low"],accessPrograms:[]}]};
 const before = {version:1 as const,checkedAt:1,entries:[entry]};
 const current = {version:1 as const,checkedAt:2,entries:[{...entry,label:"Account 2",checkedAt:2,models:["shared","novel"],entitlements:[{...entry.entitlements[0],reasoningLevels:["low","ultra"]}]}]};
 const changed = withInventoryChanges(current,before);
 expect(changed.entries[0].changes).toMatchObject({added:["novel"],removed:[],capabilities:["shared"]});
 expect(withInventoryChanges(current,null).entries[0].changes).toBeUndefined();
 const failed = withInventoryChanges({...current,checkedAt:3,entries:[{...current.entries[0],error:true,models:[],entitlements:[]}]},changed);
 expect(failed.entries[0].changes?.removed).toEqual([]);
 const recovered = withInventoryChanges({...current,checkedAt:4},failed);
 expect(recovered.entries[0].changes?.added).toEqual(["novel"]);
 expect(recovered.entries[0].changes?.observedAt).toBe(2);
});

it("summarizes model and capability differences with incomplete coverage marked unknown", () => {
 const base = {kind:"oauth" as const,enabled:true,error:false,checkedAt:1,visibleModels:[]};
 const inventory = {version:1 as const,checkedAt:1,entries:[
  {...base,id:"a",label:"Account 1 / Workspace 1",models:["shared","exclusive"],entitlements:[{model:"shared",serviceTiers:[{id:"priority",name:"Fast"}],reasoningLevels:["high"],accessPrograms:[]}]},
  {...base,id:"b",label:"Account 1 / Workspace 2",models:["shared"],entitlements:[{model:"shared",serviceTiers:[],reasoningLevels:["high"],accessPrograms:[]}]},
 ]};
 const lines = formatModelInventory(inventory,1).join("\n");
 expect(lines).toContain("Only on Account 1 / Workspace 1: exclusive");
 expect(lines).toContain("shared speed priority: Account 1 / Workspace 1");
 const incomplete = formatModelInventory({...inventory,entries:[...inventory.entries,{...base,id:"c",label:"Account 2",models:[],error:true}]},1).join("\n");
 expect(incomplete).toContain("incomplete");
 expect(incomplete).not.toContain("Only on");
});

it("styles inventory meaningfully without changing plain output or inventory data", async () => {
 const {setUiRuntimeOptions,resetUiRuntimeOptions,getUiRuntimeOptions}=await import("../lib/ui/runtime.js");
 const {stripVTControlCharacters}=await import("node:util");
 const inventory={version:1 as const,checkedAt:1000,entries:[{label:"API fixture",kind:"api" as const,enabled:true,error:true,checkedAt:1000,models:[],visibleModels:[],changes:{observedAt:1000,added:["fixture-model"],removed:[],capabilities:[]}}]};
 const before=JSON.stringify(inventory);
 vi.stubEnv("FORCE_COLOR","1");setUiRuntimeOptions({});
 try {
  const output=formatModelInventory(inventory,2000).join("\n");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.heading+"Model discovery");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.success+"  NEW");
  expect(output).toContain(getUiRuntimeOptions().theme.colors.danger+"discovery failed");
  vi.stubEnv("FORCE_COLOR","0");
  expect(stripVTControlCharacters(output)).toBe(formatModelInventory(inventory,2000).join("\n"));
  vi.stubEnv("FORCE_COLOR","");vi.stubEnv("NO_COLOR","1");
  expect(formatModelInventory(inventory,2000).join("\n")).not.toContain("\x1b");
  expect(JSON.stringify(inventory)).toBe(before);
 } finally {vi.unstubAllEnvs();resetUiRuntimeOptions();}
});
it("retains the API comparison baseline through an invalid configuration without advertising its models",async()=>{
 const {withInventoryChanges}=await import('../lib/runtime/model-discovery-status.js');
 const previous={version:1 as const,checkedAt:1,entries:[{id:'private-fixture',label:'API fixture',kind:'zdr' as const,enabled:true,error:false,checkedAt:1,models:['old-model'],visibleModels:['old-model']}]};
 const unavailable=withInventoryChanges({version:1,checkedAt:2,apiConfigurationUnavailable:true,entries:[]},previous);
 expect(unavailable.entries[0]).toMatchObject({error:true,visibleModels:[],lastSuccessful:{models:['old-model']}});
 const restored=withInventoryChanges({...previous,checkedAt:3,entries:[{...previous.entries[0]!,models:['new-model']}]},unavailable);
 expect(restored.entries[0]?.changes).toMatchObject({added:['new-model'],removed:['old-model']});
});

it("reports a failed capability refresh to the focused CLI caller", async () => {
 const {refreshAndPrintModelInventory} = await import('../lib/runtime/model-discovery-status.js');
 expect(await refreshAndPrintModelInventory(vi.fn(), {
  getBinding:async()=>({running:true,state:{nativeOpenai:true,baseUrl:'http://127.0.0.1:12345',clientApiKey:'fixture-token'}}),
  fetchImpl:vi.fn(async()=>new Response(null,{status:503})),loadInventory:async()=>null,
 })).toBe(false);
});

it("serializes independent inventory writers and preserves both successful baselines",async()=>{
 const {promises:fs}=await import("node:fs");
 const first=await import("../lib/runtime/model-discovery-status.js");
 vi.resetModules();const second=await import("../lib/runtime/model-discovery-status.js");
 const originalWrite=fs.writeFile.bind(fs),originalRename=fs.rename.bind(fs);
 let release!:()=>void,entered!:()=>void,checkpoint!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),overlap=new Promise<void>(r=>checkpoint=r);
 let parked=false;
 const write=vi.spyOn(fs,"writeFile").mockImplementation(async(...args)=>{
  if(String(args[1]).startsWith('{"version":1,"checkedAt":101,')){parked=true;entered();await gate;}
  await originalWrite(...args);
  if(String(args[1]).startsWith('{"version":1,"checkedAt":102,'))checkpoint();
 });
 const rename=vi.spyOn(fs,"rename").mockImplementation(async(...args)=>{if(parked&&String(args[1]).endsWith("model-discovery.json.write-lock"))checkpoint();return originalRename(...args);});
 const entry=(id:string,ok:boolean)=>({id,label:id,kind:"api" as const,enabled:true,error:!ok,checkedAt:ok?101:102,models:ok?[id]:[],visibleModels:[]});
 let pending:Promise<unknown>|undefined;
 try {
  const a=first.saveModelInventory({version:1,checkedAt:101,entries:[entry("writer-a",true),entry("writer-b",false)]});
  await started;
  const b=second.saveModelInventory({version:1,checkedAt:102,entries:[entry("writer-a",false),entry("writer-b",true)]});
  pending=Promise.all([a,b]);await overlap;await new Promise(r=>setImmediate(r));release();await pending;
  const result=await second.loadModelInventory();
  expect(result?.entries.map(e=>e.lastSuccessful?.models)).toEqual([["writer-a"],["writer-b"]]);
 }finally{release();await pending;write.mockRestore();rename.mockRestore();}
});

it("honours the persisted 15-minute probe cache across fresh CLI processes unless probes are forced", async () => {
 const { promises: fs } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = await fs.mkdtemp(join(tmpdir(), "probe-cache-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
 try {
  let probes = 0;
  const fetcher = vi.fn(async (url: string | URL) => {
   const href = String(url);
   if (href.endsWith("/v1/responses")) { probes++; return Response.json({ error: { message: "no" } }, { status: 500 }); }
   if (href.includes("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
   return new Response("missing", { status: 404 });
  });
  const route = { id: "fixture", label: "API fixture", kind: "api" as const, apiKey: "fixture-secret", enabled: true, priority: 0, visibleModels: ["fixture-model"], probeCapabilities: true };
  let clock = 1_000_000;
  const run = async (forceProbes?: boolean) => {
   vi.resetModules();
   const fresh = await import("../lib/runtime/model-discovery-status.js");
   await fresh.discoverModelInventory(null, [route], { fetchImpl: fetcher as typeof fetch, now: () => clock, updateApiDiscovery: async (r) => r, persistProbes: true, forceProbes });
  };
  await run();
  const first = probes;
  expect(first).toBeGreaterThan(0);
  clock += 60_000;
  await run();
  expect(probes).toBe(first);
  expect(await fs.readFile(join(dir, "api-capability-probes.json"), "utf8")).not.toContain("fixture-secret");
  await run(true);
  expect(probes).toBe(first * 2);
  clock += 16 * 60_000;
  await run();
  expect(probes).toBe(first * 3);
 } finally {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
 }
});

it("persists attributed loss timestamps over a concurrent older positive and preserves independent imports", async () => {
	const route: ApiRouteCredential = {id: "fixture", kind: "api", label: "Fixture", apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: ["X", "Y"], probeCapabilities: true};
	const independent = {...route, id: "independent", apiKey: "independent-key", visibleModels: ["X"]};
	const success = (init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const positive: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) return Response.json({data: [{id: "X"}]});
		if (init?.method === "POST") return success(init);
		return new Response("missing", {status: 404});
	};
	const updateApiDiscovery = async (credential: ApiRouteCredential) => credential;
	await discoverModelInventory(null, [route, independent], {fetchImpl: positive, now: () => 1000, updateApiDiscovery, persistProbes: true});
	let release: () => void = () => undefined, entered: () => void = () => undefined;
	const gate = new Promise<void>(resolve => {release = resolve;});
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const denying: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) return Response.json({data: [{id: "Y"}]});
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		entered(); await gate;
		return Response.json({error: {code: "invalid_api_key"}}, {status: 401});
	};
	const pending = discoverModelInventory(null, [route], {fetchImpl: denying, now: () => 3000, updateApiDiscovery, persistProbes: true});
	try {
		await ready;
		await discoverModelInventory(null, [route], {fetchImpl: positive, now: () => 2000, updateApiDiscovery, persistProbes: true, forceProbes: true});
	} finally {release();}
	await pending;
	let posts = 0;
	const reloaded = await discoverModelInventory(null, [route, independent], {fetchImpl: async (url, init) => {if (init?.method === "POST") posts++; return positive(url, init);}, now: () => 4000, updateApiDiscovery, persistProbes: true});
	expect(posts).toBe(0);
	const denied = reloaded.entries.find(entry => entry.label === route.label)?.entitlements?.find(model => model.model === "X");
	const unaffected = reloaded.entries.filter(entry => entry.kind === "api")[1]?.entitlements?.[0];
	expect(denied?.probes?.responses).toBe("unverified");
	expect(denied?.serviceTiers).toEqual([]);
	expect(unaffected?.probes?.responses).toBe("verified");
	const serialized = await isolationFs.readFile(isolationJoin(multiAuthDir, "api-capability-probes.json"), "utf8");
	expect(serialized).not.toContain("fixture-key");
	expect(serialized).not.toContain("independent-key");
	const entries = JSON.parse(serialized).entries as Array<[string, {at: number; status: Record<string, string>}]>;
	for (const [, result] of entries.filter(([, result]) => result.status.responses === "unverified")) expect(result.at).toBe(3000);
});

it.each([1000, 900])("accepts observed-loss forced recovery despite clock ordering (%s)", async recoveryClock => {
	const route: ApiRouteCredential = {id: "clock-recovery", kind: "api", label: "Recovery", apiKey: "fixture-clock-secret", enabled: true, priority: 0, visibleModels: ["X"], probeCapabilities: true};
	const options = {updateApiDiscovery: async (credential: ApiRouteCredential) => credential, persistProbes: true, forceProbes: true};
	const denied: typeof fetch = async (url, init) => init?.method === "POST" ? Response.json({error: {code: "invalid_api_key"}}, {status: 401}) : String(url).endsWith("/models") ? Response.json({data: [{id: "X"}]}) : new Response("missing", {status: 404});
	for (let i = 0; i < 2; i++) await discoverModelInventory(null, [route], {...options, fetchImpl: denied, now: () => 1000});
	const path = isolationJoin(multiAuthDir, "api-capability-probes.json");
	expect(JSON.parse(await isolationFs.readFile(path, "utf8")).ownerLosses[0][1]).toBe(1001);
	let posts = 0;
	const healthy: typeof fetch = async (url, init) => {
		if (init?.method !== "POST") return String(url).endsWith("/models") ? Response.json({data: [{id: "X"}]}) : new Response("missing", {status: 404});
		posts++;
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const recovered = await discoverModelInventory(null, [route], {...options, fetchImpl: healthy, now: () => recoveryClock});
	expect(posts).toBeGreaterThan(0);
	expect(recovered.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("verified");
	expect(recovered.entries[0]?.entitlements?.[0]?.serviceTiers).toContainEqual(expect.objectContaining({id: "priority"}));
	expect(recovered.entries[0]?.entitlements?.[0]?.probes?.fast).toBe("verified");
	const persisted = JSON.parse(await isolationFs.readFile(path, "utf8"));
	expect(persisted.entries[0][1]).toMatchObject({observedLossAt: 1001, status: {responses: "verified"}});
	posts = 0;
	const reloaded = await discoverModelInventory(null, [route], {...options, forceProbes: false, fetchImpl: healthy, now: () => recoveryClock});
	expect(posts).toBe(0);
	expect(reloaded.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("verified");
});

it("asks a running proxy to force paid probes only for an explicit capability check", async () => {
 const { refreshAndPrintModelInventory } = await import("../lib/runtime/model-discovery-status.js");
 const urls: string[] = [];
 for (const forceProbes of [false, true]) {
  const inventory = { version: 1 as const, checkedAt: 200, entries: [] };
  const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(inventory);
  await refreshAndPrintModelInventory(vi.fn(), {
   getBinding: async () => ({ running: true, state: { nativeOpenai: true, baseUrl: "http://127.0.0.1:12345", clientApiKey: "fixture-token" } }),
   fetchImpl: (async (url: URL) => { urls.push(String(url)); return Response.json({ models: [] }); }) as unknown as typeof fetch,
   loadInventory: load, now: () => 100, forceProbes,
  });
 }
 expect(urls).toEqual(["http://127.0.0.1:12345/models?refresh_capabilities=1&client_version=0.160.0", "http://127.0.0.1:12345/models?refresh_capabilities=1&force_probes=1&client_version=0.160.0"]);
});

it.each(["transport", "server"].flatMap(mode => [2000, 3000, 4000].map(startedAt => ({mode, startedAt}))))
("does not let a late probe resurrect another process's persisted credential loss (%j)", async ({mode, startedAt}) => {
	const route: ApiRouteCredential = {id: "late-writer", kind: "api", label: "Late writer", apiKey: "fixture-late-secret", enabled: true, priority: 0, visibleModels: ["X", "Y"], probeCapabilities: true};
	const independent = {...route, id: "independent", label: "Independent", apiKey: "fixture-independent-secret"};
	const positive: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) return Response.json({data: [{id: "X"}]});
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const updateApiDiscovery = async (credential: ApiRouteCredential) => credential;
	await discoverModelInventory(null, [route, independent], {fetchImpl: positive, now: () => 1000, updateApiDiscovery, persistProbes: true});
	let entered: () => void = () => undefined, release: () => void = () => undefined, clock = startedAt;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const delayed: typeof fetch = async (url, init) => {
		if (init?.method !== "POST") return positive(url, init);
		entered(); await gate;
		if (mode === "transport") throw Error("fixture transport unavailable");
		return Response.json({error: {code: "server_error"}}, {status: 500});
	};
	const pending = discoverModelInventory(null, [route], {fetchImpl: delayed, now: () => clock, updateApiDiscovery, persistProbes: true, forceProbes: true});
	try {
		await ready;
		await discoverModelInventory(null, [route], {fetchImpl: async (url, init) => init?.method === "POST" ? Response.json({error: {code: "invalid_api_key"}}, {status: 401}) : String(url).endsWith("/models") ? Response.json({data: [{id: "Y"}]}) : new Response("missing", {status: 404}), now: () => 3000, updateApiDiscovery, persistProbes: true});
	} finally {clock = 4000; release();}
	const late = await pending;
	expect(late.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("unverified");
	expect(late.entries[0]?.entitlements?.[0]?.serviceTiers).toEqual([]);
	let posts = 0;
	const cached = await discoverModelInventory(null, [route, independent], {fetchImpl: async (url, init) => {if (init?.method === "POST") posts++; return positive(url, init);}, now: () => 5000, updateApiDiscovery, persistProbes: true});
	expect(posts).toBe(0);
	const denied = cached.entries.find(entry => entry.label === route.label)?.entitlements?.[0];
	const retained = cached.entries.find(entry => entry.label === independent.label)?.entitlements?.[0];
	expect(denied?.probes?.responses).toBe("unverified");
	expect(denied?.serviceTiers).toEqual([]);
	expect(retained?.probes?.responses).toBe("verified");
	const recovered = await discoverModelInventory(null, [route], {fetchImpl: positive, now: () => 6000, updateApiDiscovery, persistProbes: true, forceProbes: true});
	expect(recovered.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("verified");
	const serialized = await isolationFs.readFile(isolationJoin(multiAuthDir, "api-capability-probes.json"), "utf8");
	expect(serialized).not.toContain("fixture-late-secret");
	expect(serialized).not.toContain("fixture-independent-secret");
});

it.each(["malformed", "schema", "oversized", "directory", "unreadable"])("rejects %s capability authority before API discovery", async mode => {
	const path = isolationJoin(multiAuthDir, "api-capability-probes.json");
	if (mode === "directory") await isolationFs.mkdir(path);
	else if (mode === "unreadable") {
		const open = isolationFs.open.bind(isolationFs);
		vi.spyOn(isolationFs, "open").mockImplementation(async (...args) => {
			if (String(args[0]) === path) throw Object.assign(Error("fixture authority unavailable"), {code: "EACCES"});
			return open(...args);
		});
	} else await isolationFs.writeFile(path, mode === "malformed" ? "{" : mode === "schema" ? JSON.stringify({version: 2, entries: []}) : " ".repeat(4 * 1024 * 1024 + 1));
	const fetchImpl = vi.fn(async () => Response.json({data: [{id: "X"}]}));
	const route: ApiRouteCredential = {id: "authority", kind: "api", label: "Authority", apiKey: "fixture-secret", enabled: true, priority: 0, visibleModels: ["X"], probeCapabilities: true};
	await expect(discoverModelInventory(null, [route], {fetchImpl, updateApiDiscovery: async credential => credential, persistProbes: true})).rejects.toThrow();
	expect(fetchImpl).not.toHaveBeenCalled();
});

it.each(["rename", "write", "lock", "reread", "malformed-reread"])("rejects a late writer when %s prevents capability reconciliation", async mode => {
	const path = isolationJoin(multiAuthDir, "api-capability-probes.json");
	const route: ApiRouteCredential = {id: "late-failure", kind: "api", label: "Late failure", apiKey: "fixture-secret", enabled: true, priority: 0, visibleModels: ["X", "Y"], probeCapabilities: true};
	const positive: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) return Response.json({data: [{id: "X"}]});
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const options = {updateApiDiscovery: async (credential: ApiRouteCredential) => credential, persistProbes: true};
	const initial = await discoverModelInventory(null, [route], {...options, fetchImpl: positive, now: () => 1000});
	expect(initial.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("verified");
	let entered: () => void = () => undefined, release: () => void = () => undefined;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const pending = discoverModelInventory(null, [route], {...options, now: () => 4000, forceProbes: true, fetchImpl: async (url, init) => {
		if (init?.method !== "POST") return positive(url, init);
		entered(); await gate;
		return Response.json({error: {code: "server_error"}}, {status: 500});
	}});
	const rejected = expect(pending).rejects.toThrow();
	try {
		await ready;
		await discoverModelInventory(null, [route], {...options, now: () => 3000, fetchImpl: async (url, init) => init?.method === "POST" ? Response.json({error: {code: "invalid_api_key"}}, {status: 401}) : String(url).endsWith("/models") ? Response.json({data: [{id: "Y"}]}) : new Response("missing", {status: 404})});
		if (mode === "reread") {
			const open = isolationFs.open.bind(isolationFs);
			vi.spyOn(isolationFs, "open").mockImplementation(async (...args) => {
				if (String(args[0]) === path) throw Object.assign(Error("fixture reread denied"), {code: "EACCES"});
				return open(...args);
			});
		} else if (mode === "malformed-reread") await isolationFs.writeFile(path, "{");
		else if (mode === "write") {
			const write = isolationFs.writeFile.bind(isolationFs);
			vi.spyOn(isolationFs, "writeFile").mockImplementation(async (...args) => {
				if (String(args[0]).startsWith(path + ".") && !String(args[0]).includes("write-lock")) throw Object.assign(Error("fixture full disk"), {code: "ENOSPC"});
				return write(...args);
			});
		} else {
			const rename = isolationFs.rename.bind(isolationFs);
			vi.spyOn(isolationFs, "rename").mockImplementation(async (...args) => {
				if (String(args[1]) === (mode === "lock" ? path + ".write-lock" : path)) throw Object.assign(Error("fixture commit denied"), {code: "ENOSPC"});
				return rename(...args);
			});
		}
	} finally {release();}
	await rejected;
	vi.restoreAllMocks();
	if (mode !== "malformed-reread") {
		let posts = 0;
		const cached = await discoverModelInventory(null, [route], {...options, now: () => 5000, fetchImpl: async (url, init) => {if (init?.method === "POST") posts++; return positive(url, init);}});
		expect(posts).toBe(0);
		expect(cached.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("unverified");
	}
});

it("retains credential loss after 1000 newer model results evict its entries", async () => {
	const route: ApiRouteCredential = {id: "evicted", kind: "api", label: "Evicted", apiKey: "fixture-evicted-secret", enabled: true, priority: 0, visibleModels: ["X", "Y"], probeCapabilities: true};
	const independent = {...route, id: "independent", label: "Independent", apiKey: "fixture-independent-secret", visibleModels: ["stable"]};
	const churn = {...route, id: "churn", label: "Churn", apiKey: "fixture-churn-secret", visibleModels: Array.from({length: 1000}, (_, index) => `M${index}`)};
	const positive: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) {
			const key = new Headers(init?.headers).get("authorization");
			return Response.json({data: (key === `Bearer ${independent.apiKey}` ? independent.visibleModels : key === `Bearer ${churn.apiKey}` ? churn.visibleModels : ["X"]).map(id => ({id}))});
		}
		if (init?.method !== "POST") return String(url).endsWith("/X.md") ? new Response("Model ID: `X`\nReasoning.effort supports: low.") : new Response("missing", {status: 404});
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const options = {persistProbes: true, updateApiDiscovery: async (credential: ApiRouteCredential) => credential};
	await discoverModelInventory(null, [route, independent], {...options, fetchImpl: positive, now: () => 1000});
	let entered: () => void = () => undefined, release: () => void = () => undefined;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const late = discoverModelInventory(null, [route], {...options, now: () => 5000, forceProbes: true, fetchImpl: async (url, init) => {
		if (init?.method !== "POST") return positive(url, init);
		entered(); await gate; return new Response("inconclusive", {status: 500});
	}});
	const path = isolationJoin(multiAuthDir, "api-capability-probes.json");
	try {
		await ready;
		await discoverModelInventory(null, [route], {...options, now: () => 3000, fetchImpl: async (url, init) => init?.method === "POST" ? Response.json({error: {code: "invalid_api_key"}}, {status: 401}) : String(url).endsWith("/models") ? Response.json({data: [{id: "Y"}]}) : positive(url, init)});
		const lossSnapshot = JSON.parse(await isolationFs.readFile(path, "utf8"));
		const losses: Array<[string, number]> = lossSnapshot.ownerLosses ?? lossSnapshot.entries.flatMap(([, result]: [string, {credentialOwner?: string; lostAt?: number}]) => result.credentialOwner && result.lostAt !== undefined ? [[result.credentialOwner, result.lostAt]] : []);
		await discoverModelInventory(null, [churn], {...options, now: () => 4000, fetchImpl: positive});
		const evicted = JSON.parse(await isolationFs.readFile(path, "utf8"));
		expect(evicted.entries).toHaveLength(1000);
		expect(evicted.entries.every((entry: [string, {credentialOwner: string}]) => !losses.some(([owner]: [string, number]) => owner === entry[1].credentialOwner))).toBe(true);
		await discoverModelInventory(null, [independent], {...options, now: () => 4500, forceProbes: true, fetchImpl: positive});
	} finally {release();}
	const published = await late;
	expect(published.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("unverified");
	expect(published.entries[0]?.entitlements?.[0]?.serviceTiers).toEqual([]);
	expect(JSON.parse(await isolationFs.readFile(path, "utf8")).ownerLosses).toHaveLength(1);
	let posts = 0;
	const restored = await discoverModelInventory(null, [route, independent], {...options, now: () => 6000, fetchImpl: async (url, init) => {if (init?.method === "POST") posts++; return positive(url, init);}});
	expect(posts).toBe(0);
	expect(restored.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("unverified");
	expect(restored.entries[0]?.entitlements?.[0]?.reasoningLevels).toContain("low");
	expect(restored.entries[1]?.entitlements?.[0]?.probes?.responses).toBe("verified");
	const recovered = await discoverModelInventory(null, [route], {...options, now: () => 7000, forceProbes: true, fetchImpl: positive});
	expect(recovered.entries[0]?.entitlements?.[0]?.probes?.responses).toBe("verified");
	const serialized = await isolationFs.readFile(path, "utf8");
	for (const credential of [route, independent, churn]) expect(serialized).not.toContain(credential.apiKey);
	expect(Buffer.byteLength(serialized)).toBeLessThan(4 * 1024 * 1024);
});

it("rejects owner authority overflow without replacing committed cache bytes", async () => {
	const path = isolationJoin(multiAuthDir, "api-capability-probes.json");
	const committed = JSON.stringify({version: 1, entries: [], ownerLosses: Array.from({length: 1000}, (_, index) => [index.toString(16).padStart(64, "0"), 0])});
	await isolationFs.writeFile(path, committed);
	const route: ApiRouteCredential = {id: "overflow", kind: "api", label: "Overflow", apiKey: "fixture-overflow", enabled: true, priority: 0, visibleModels: ["X"], probeCapabilities: true};
	await expect(discoverModelInventory(null, [route], {persistProbes: true, now: () => 1000, updateApiDiscovery: async credential => credential, fetchImpl: async (url, init) => init?.method === "POST" ? Response.json({error: {code: "invalid_api_key"}}, {status: 401}) : String(url).endsWith("/models") ? Response.json({data: [{id: "X"}]}) : new Response("missing", {status: 404})})).rejects.toThrow("capacity");
	expect(await isolationFs.readFile(path, "utf8")).toBe(committed);
});

it("merges concurrent checks' probe results instead of replacing the shared cache", async () => {
 const { promises: fs } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = await fs.mkdtemp(join(tmpdir(), "probe-merge-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
 try {
  let probes = 0;
  const fetcher = vi.fn(async (url: string | URL) => {
   const href = String(url);
   if (href.endsWith("/v1/responses")) { probes++; return Response.json({ error: { message: "no" } }, { status: 500 }); }
   if (href.includes("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
   return new Response("missing", { status: 404 });
  });
  const route = (id: string) => ({ id, label: id, kind: "api" as const, apiKey: `key-${id}`, enabled: true, priority: 0, visibleModels: ["fixture-model"], probeCapabilities: true });
  vi.resetModules();
  const a = await import("../lib/runtime/model-discovery-status.js");
  vi.resetModules();
  const b = await import("../lib/runtime/model-discovery-status.js");
  const options = { fetchImpl: fetcher as typeof fetch, now: () => 1_000_000, updateApiDiscovery: async (r: never) => r, persistProbes: true };
  // Both start from the same (empty) cache and probe different credentials.
  await Promise.all([a.discoverModelInventory(null, [route("one")], options), b.discoverModelInventory(null, [route("two")], options)]);
  const cached = JSON.parse(await fs.readFile(join(dir, "api-capability-probes.json"), "utf8")).entries;
  expect(cached).toHaveLength(2);
  const before = probes;
  vi.resetModules();
  const c = await import("../lib/runtime/model-discovery-status.js");
  await c.discoverModelInventory(null, [route("one"), route("two")], options);
  expect(probes).toBe(before);
 } finally {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
 }
});

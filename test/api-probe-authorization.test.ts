import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiModelCapabilities } from "../lib/runtime/api-model-capabilities.js";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import { discoverModelInventory } from "../lib/runtime/model-discovery-status.js";
import { getApiRoutesPath, saveApiRoutes, updateApiModelDiscovery, type ApiRouteCredential } from "../lib/api-route-store.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { isRecord } from "../lib/utils.js";

const route: ApiRouteCredential = {id: "fixture", kind: "zdr", label: "Fixture", apiKey: "fixture-probe-key", enabled: true, priority: 0, visibleModels: ["fixture"], probeCapabilities: true};
let directory: string;
let previous: string | undefined;
beforeEach(async () => {
	directory = await fs.mkdtemp(join(tmpdir(), "probe-authorization-"));
	previous = process.env.CODEX_MULTI_AUTH_DIR;
	process.env.CODEX_MULTI_AUTH_DIR = directory;
	await saveApiRoutes([route]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (previous === undefined) delete process.env.CODEX_MULTI_AUTH_DIR;
	else process.env.CODEX_MULTI_AUTH_DIR = previous;
	await removeWithRetry(directory, {recursive: true, force: true});
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {resolve = done;});
	return {promise, resolve};
}
function heldFetcher(stage: "documentation" | "slots") {
	const entered = deferred(), gate = deferred();
	const posts: string[] = [];
	const payloads: unknown[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		if (String(url).endsWith("/models")) return Response.json({data: [{id: "fixture"}]});
		if (init?.method !== "POST") {
			if (stage === "documentation") {entered.resolve(); await gate.promise;}
			return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
		}
		posts.push(new Headers(init.headers).get("authorization") ?? "");
		if (stage === "slots" && posts.length <= 4) {
			if (posts.length === 4) entered.resolve();
			await gate.promise;
		}
		const body = JSON.parse(String(init.body));
		payloads.push(body);
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	return {fetcher, posts, payloads, entered, gate};
}
const mutations = ["disable", "delete", "rekey", "kind", "consent", "unreadable", "source", "unchanged"] as const;
async function mutate(mutation: typeof mutations[number]) {
	if (mutation === "unreadable") {await fs.writeFile(getApiRoutesPath(), "{"); return;}
	if (mutation === "source") {process.env.CODEX_MULTI_AUTH_DIR = join(directory, "replacement"); return;}
	await saveApiRoutes(mutation === "delete" ? [] : [{...route,
		...(mutation === "disable" ? {enabled: false} : {}),
		...(mutation === "rekey" ? {apiKey: "replacement-fixture-key"} : {}),
		...(mutation === "kind" ? {kind: "api"} : {}),
		...(mutation === "consent" ? {probeCapabilities: false} : {}),
	}]);
}
it.each(mutations.flatMap(mutation => (["documentation", "slots"] as const).map(stage => ({mutation, stage}))))("keeps configured authority across paid probe waits: %j", async ({mutation, stage}) => {
	const held = heldFetcher(stage);
	const capabilities = new ApiModelCapabilities(held.fetcher);
	const pending = capabilities.enrich([{slug: "fixture"}], true, route, true);
	const outcome = pending.then(value => ({value, error: false}), () => ({value: [], error: true}));
	try {
		await held.entered.promise;
		await mutate(mutation);
	} finally {held.gate.resolve();}
	const result = await outcome;
	if (mutation === "unchanged") {
		expect(result.error).toBe(false);
		expect(result.value[0]?.capability_probe_status).toMatchObject({responses: "verified", fast: "verified"});
		expect(held.posts).toHaveLength(9);
		expect(held.payloads.filter(isRecord).filter(body => !body.tools && !body.service_tier).map(body => isRecord(body.reasoning) ? body.reasoning.effort : undefined).sort()).toEqual(["high", "max", "medium", "minimal", "none", "xhigh"]);
		expect(held.payloads.filter(isRecord).filter(body => body.tools || body.service_tier)).toHaveLength(3);
		expect(held.payloads.filter(isRecord).filter(body => body.tools || body.service_tier).every(body => isRecord(body.reasoning) && body.reasoning.effort === "low")).toBe(true);
		expect(capabilities.exportProbes()).toHaveLength(1);
	} else {
		expect(result.error).toBe(true);
		expect(held.posts).toHaveLength(stage === "documentation" ? 0 : 4);
		expect(capabilities.exportProbes()).toEqual([]);
	}
	expect(held.posts.every(key => key === "Bearer fixture-probe-key")).toBe(true);
	expect(capabilities.exportOwnerLosses()).toEqual([]);
});

it("rechecks consent at the final persisted probe publication", async () => {
	const held = heldFetcher("documentation");
	held.gate.resolve();
	const entered = deferred(), gate = deferred();
	const write = fs.writeFile.bind(fs);
	const intercepted = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		await write(...args);
		if (String(args[0]).includes("api-capability-probes.json")) {entered.resolve(); await gate.promise;}
	});
	const pending = discoverModelInventory(null, [route], {fetchImpl: held.fetcher, updateApiDiscovery: updateApiModelDiscovery, persistProbes: true});
	const outcome = pending.then(() => false, () => true);
	try {await entered.promise; await saveApiRoutes([{...route, probeCapabilities: false}]);}
	finally {gate.resolve();}
	expect(await outcome).toBe(true);
	intercepted.mockRestore();
	expect(held.posts).toHaveLength(9);
	expect(held.payloads.filter(isRecord).filter(body => !body.tools && !body.service_tier).map(body => isRecord(body.reasoning) ? body.reasoning.effort : undefined)).not.toContain("low");
	await expect(fs.stat(join(directory, "api-capability-probes.json"))).rejects.toMatchObject({code: "ENOENT"});
});

it.each(["runtime", "discovery"] as const)("denies result publication and new sends in the %s integration", async integration => {
	const held = heldFetcher("slots");
	const capabilities = new ApiModelCapabilities(held.fetcher);
	const runtime = new ApiModelRuntime(held.fetcher, Date.now, updateApiModelDiscovery,
		(models, refresh, credential, force, authorize) => capabilities.enrich(models, refresh, credential, force, authorize));
	const pending = integration === "runtime" ? runtime.catalogs([route], true, true) : discoverModelInventory(null, [route], {fetchImpl: held.fetcher, updateApiDiscovery: updateApiModelDiscovery, persistProbes: true});
	const outcome = pending.then(() => false, () => true);
	try {await held.entered.promise; await saveApiRoutes([{...route, probeCapabilities: false}]);}
	finally {held.gate.resolve();}
	expect(await outcome).toBe(true);
	expect(held.posts).toHaveLength(4);
	expect(capabilities.exportProbes()).toEqual([]);
	expect(runtime.cachedCatalogs().flatMap(catalog => catalog.models).some(model => model.capability_probe_status)).toBe(false);
	await expect(fs.stat(join(directory, "api-capability-probes.json"))).rejects.toMatchObject({code: "ENOENT"});
});

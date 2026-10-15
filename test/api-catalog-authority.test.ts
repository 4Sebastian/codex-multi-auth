import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {captureApiProbeAuthorization, saveApiRoutes, loadApiRoutes, getApiRoutesPath, updateApiModelDiscovery, type ApiRouteCredential} from "../lib/api-route-store.js";
import {ApiModelRuntime} from "../lib/runtime/api-model-runtime.js";
import {discoverModelInventory, saveModelInventory} from "../lib/runtime/model-discovery-status.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";
import {AccountManager} from "../lib/accounts.js";
import {startRuntimeRotationProxy} from "../lib/runtime-rotation-proxy.js";

let root: string;
beforeEach(async () => {
 root = await fs.mkdtemp(join(tmpdir(), "catalog-authority-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", root);
});
afterEach(async () => {
 vi.restoreAllMocks(); vi.unstubAllEnvs();
 await removeWithRetry(root, {recursive: true, force: true});
});
function deferred() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => {resolve = done;});
 return {promise, resolve};
}
function credential(id: string): ApiRouteCredential {
 return {id, kind: "api", label: id, apiKey: `fixture-${id}`, enabled: true, priority: 0, visibleModels: ["gpt-fixture"], probeCapabilities: false};
}
const mutations = ["disable", "delete", "rekey", "kind", "source", "unreadable", "unchanged"] as const;
async function mutate(routes: ApiRouteCredential[], id: string, mutation: typeof mutations[number]) {
 if (mutation === "source") {process.env.CODEX_MULTI_AUTH_DIR = join(root, "replacement"); return;}
 if (mutation === "unreadable") {await fs.writeFile(getApiRoutesPath(), "{"); return;}
 await saveApiRoutes(routes.flatMap(route => route.id !== id ? [route] : mutation === "delete" ? [] : [{...route,
  ...(mutation === "disable" ? {enabled: false} : {}), ...(mutation === "rekey" ? {apiKey: "replacement-key"} : {}), ...(mutation === "kind" ? {kind: "zdr" as const} : {}),
 }]));
}
it("does not adopt a replacement source before catalog capture", async () => {
 const route = credential("original"); await saveApiRoutes([route]);
 const original = await loadApiRoutes();
 process.env.CODEX_MULTI_AUTH_DIR = join(root, "replacement");
 await saveApiRoutes([route]);
 const fetcher = vi.fn(async () => Response.json({data: [{id: "gpt-fixture"}]}));
 const catalogs = await new ApiModelRuntime(fetcher).catalogs(original);
 expect(fetcher).not.toHaveBeenCalled();
 expect(catalogs.every(catalog => !catalog.enabled && catalog.visibleModels?.length === 0)).toBe(true);
});
it.each(mutations)("checks a queued fourth non-probing catalog before its GET: %s", async mutation => {
 const routes = ["one", "two", "three", "four"].map(credential);
 await saveApiRoutes(routes);
 const entered = deferred(), gate = deferred();
 const sent: string[] = [];
 let posts = 0;
 const runtime = new ApiModelRuntime(async (_url, init) => {
  if (init?.method === "POST") posts++;
  const key = new Headers(init?.headers).get("authorization") ?? "";
  sent.push(key);
  if (sent.length === 3) entered.resolve();
  if (key !== "Bearer fixture-four") await gate.promise;
  return Response.json({data: [{id: "gpt-fixture"}]});
 });
 const pending = runtime.catalogs(await loadApiRoutes());
 try {await entered.promise; await mutate(routes, "four", mutation);} finally {gate.resolve();}
 const catalogs = await pending;
 expect(sent.includes("Bearer fixture-four")).toBe(mutation === "unchanged");
 expect(sent.some(key => key.includes("replacement"))).toBe(false);
 expect(posts).toBe(0);
 expect(catalogs.find(catalog => catalog.id === "four")?.enabled).toBe(mutation === "unchanged");
 if (!["source", "unreadable"].includes(mutation)) expect(catalogs.filter(catalog => catalog.id !== "four").every(catalog => catalog.enabled && catalog.models.length === 1)).toBe(true);
});
it.each(mutations.flatMap(mutation => ["runtime", "standalone"].map(integration => ({mutation, integration}))))("rejects non-probing catalog authority lost while a response is pending: %j", async ({mutation, integration}) => {
 const routes = [credential("held"), credential("independent")];
 await saveApiRoutes(routes);
 const entered = deferred(), gate = deferred();
 const sent: string[] = [];
 const fetcher: typeof fetch = async (_url, init) => {
  expect(init?.method).toBe("GET");
  const key = new Headers(init?.headers).get("authorization") ?? "";
  sent.push(key);
  if (sent.length === 2) entered.resolve();
  return new Response(new ReadableStream({async start(controller) {
   if (key === "Bearer fixture-held") await gate.promise;
   controller.enqueue(Buffer.from(JSON.stringify({data: [{id: "gpt-fixture"}]}))); controller.close();
  }}));
 };
 const runtime = new ApiModelRuntime(fetcher);
 const configured = await loadApiRoutes();
 const pending = integration === "runtime" ? runtime.catalogs(configured) : discoverModelInventory(null, configured, {fetchImpl: fetcher});
 const outcome = pending.then(value => ({value}), error => ({error}));
 try {await entered.promise; await mutate(routes, "held", mutation);} finally {gate.resolve();}
 const result = await outcome;
 expect(sent.sort()).toEqual(["Bearer fixture-held", "Bearer fixture-independent"].sort());
 if (integration === "runtime") {
  expect("error" in result).toBe(false);
  const catalogs = runtime.cachedCatalogs();
  expect(catalogs.find(catalog => catalog.id === "held")?.enabled).toBe(mutation === "unchanged");
  if (!["source", "unreadable"].includes(mutation)) expect(catalogs.find(catalog => catalog.id === "independent")?.enabled).toBe(true);
 } else expect("error" in result).toBe(mutation !== "unchanged");
});
it.each(mutations)("revalidates a non-probing catalog at persisted inventory publication: %s", async mutation => {
 const routes = [credential("held")];
 await saveApiRoutes(routes);
 const value = await discoverModelInventory(null, await loadApiRoutes(), {fetchImpl: async () => Response.json({data: [{id: "gpt-fixture"}]})});
 const entered = deferred(), gate = deferred(), write = fs.writeFile.bind(fs);
 vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
  await write(...args);
  if (String(args[0]).includes("model-discovery.json.")) {entered.resolve(); await gate.promise;}
 });
 const pending = saveModelInventory(value);
 try {await entered.promise; await mutate(routes, "held", mutation);} finally {gate.resolve();}
 await pending;
 const persisted = JSON.parse(await fs.readFile(join(root, "model-discovery.json"), "utf8"));
 expect(persisted.entries[0].enabled).toBe(mutation === "unchanged");
 expect(persisted.entries[0].visibleModels).toEqual(mutation === "unchanged" ? ["gpt-fixture"] : []);
});
it("checks the original route before discovery metadata rename", async () => {
 const route = credential("held");
 await saveApiRoutes([route]);
 const entered = deferred(), gate = deferred(), write = fs.writeFile.bind(fs);
 let held = false;
 vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
  await write(...args);
  if (!held && String(args[0]).includes("api-routes.json.") && !String(args[0]).includes("write-lock")) {held = true; entered.resolve(); await gate.promise;}
 });
 const pending = updateApiModelDiscovery((await loadApiRoutes())[0]!, ["gpt-fixture", "gpt-new"]);
 const outcome = pending.then(() => false, () => true);
 try {await entered.promise; await fs.writeFile(getApiRoutesPath(), JSON.stringify({version: 1, routes: [{...route, enabled: false}]}));} finally {gate.resolve();}
 expect(await outcome).toBe(true);
 expect((await loadApiRoutes())[0]).toMatchObject({enabled: false, visibleModels: ["gpt-fixture"]});
});
it("does not temporarily downgrade paid cache proof while enrichment authorization waits", async () => {
 const route = {...credential("paid"), probeCapabilities: true}; await saveApiRoutes([route]);
 const entered = deferred(), gate = deferred(); let enrichments = 0, waiting = false;
 const runtime = new ApiModelRuntime(async () => Response.json({data: [{id: "gpt-fixture"}]}), Date.now, undefined,
  async models => {if (++enrichments === 2) waiting = true; return models.map(model => ({...model, capability_probe_status: {responses: "supported"}}));},
  undefined, original => {
   const authorize = captureApiProbeAuthorization(original);
   return async () => {const proof = await authorize(); if (waiting) {entered.resolve(); await gate.promise;} return proof;};
  });
 await runtime.catalogs([route]);
 expect(runtime.cachedCatalogs().some(catalog => catalog.enabled)).toBe(true);
 const pending = runtime.catalogs([route], true, false, false);
 try {
  await entered.promise; await saveApiRoutes([{...route, probeCapabilities: false}]);
  expect(runtime.cachedCatalogs().every(catalog => !catalog.enabled && catalog.models.length === 0)).toBe(true);
 } finally {gate.resolve(); await pending;}
 expect(runtime.cachedCatalogs().every(catalog => !catalog.enabled && catalog.models.length === 0)).toBe(true);
});
it.each(["body", "publication"] as const)("removes revoked non-probing models and ETags through the production native %s path", async stage => {
 const route = credential("held");
 await saveApiRoutes([route]);
 const entered = deferred(), gate = deferred();
 let holding = false;
 let gets = 0, posts = 0;
 const manager = new AccountManager(undefined, {version: 3, accounts: [], activeIndex: 0});
 const proxy = await startRuntimeRotationProxy({nativeOpenai: true, accountManager: manager, clientApiKey: "fixture-client", fetchImpl: async (url, init) => {
  if (!String(url).endsWith("/v1/models")) {if (init?.method === "POST") posts++; return new Response("missing", {status: 404});}
  gets++;
  if (holding && stage === "body") {entered.resolve(); await gate.promise;}
  return Response.json({data: [{id: "gpt-fixture"}]});
 }});
 const read = () => fetch(`${proxy.baseUrl}/models?refresh_capabilities=1&client_version=0.125.0`, {headers: {authorization: "Bearer fixture-client"}});
 try {
  const first = await read(); expect(first.status).toBe(200);
  expect((await first.json()).models.map(model => model.slug)).toContain("api/gpt-fixture");
  holding = true;
  if (stage === "publication") {
   const write = fs.writeFile.bind(fs);
   vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await write(...args);
    if (holding && String(args[0]).includes("model-discovery.json.")) {entered.resolve(); await gate.promise;}
   });
  }
  const pending = read();
  try {await entered.promise; await saveApiRoutes([{...route, enabled: false}]);} finally {gate.resolve();}
  const response = await pending;
  expect(response.status).toBe(503);
  await response.text();
  expect(response.headers.get("etag")).not.toBe(first.headers.get("etag"));
  const persisted = JSON.parse(await fs.readFile(join(root, "model-discovery.json"), "utf8"));
  expect(persisted.entries.filter(entry => entry.kind === "api").every(entry => !entry.enabled && entry.visibleModels.length === 0)).toBe(true);
  expect(gets).toBe(2); expect(posts).toBe(0);
 } finally {gate.resolve(); await proxy.close(); await manager.flushPendingSave();}
});
it.each((["api", "zdr"] as const).flatMap(kind => ["alias", "body", "equivalent", "priority"].map(selection => ({kind, selection}))))("sends provider Priority for every accepted Fast selection: %j", async ({kind, selection}) => {
 const route = {...credential("tier"), kind};
 await saveApiRoutes([route]);
 const sent: Record<string, unknown>[] = [];
 const runtime = new ApiModelRuntime(async (_url, init) => {
  if (init?.method !== "POST") return Response.json({data: [{id: "gpt-fixture"}]});
  const body = JSON.parse(String(init.body)); sent.push(body);
  return body.service_tier === "priority" ? Response.json({service_tier: "priority"}) : Response.json({error: {code: "unsupported_value", param: "service_tier"}}, {status: 400});
 }, Date.now, undefined, async models => models.map(model => ({...model, service_tiers: [{id: "priority", name: "Fast", description: "Fixture"}]})));
 const model = `${kind}/${selection === "alias" || selection === "equivalent" ? "speed/fast/" : ""}gpt-fixture`;
 const response = await runtime.request(model, {model, ...(selection === "body" ? {service_tier: "fast"} : selection !== "alias" ? {service_tier: "priority"} : {})}, await loadApiRoutes());
 expect(response.status).toBe(200);
 expect(sent).toHaveLength(1);
 expect(sent[0]).toMatchObject({model: "gpt-fixture", service_tier: "priority", store: false});
});

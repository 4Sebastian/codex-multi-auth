import { describe, it, expect, vi } from "vitest";
import { isRecord } from "../lib/utils.js";
import {
	ApiModelCapabilities,
	parseApiReasoningDocumentation,
} from "../lib/runtime/api-model-capabilities.js";
describe("public API reasoning metadata", () => {
	it("reads only an explicit support statement for the exact model", () => {
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\n`reasoning.effort` supports `low`, `medium` (default), `high`, and `max`.",
			),
		).toEqual(["low", "medium", "high", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning.effort supports: none, low, medium (default), high, xhigh, and max.",
			),
		).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `other`\nReasoning.effort supports: low, high.",
			),
		).toEqual([]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning effort may include low or high depending on the model.",
			),
		).toEqual([]);
	});
	it("requests public metadata without credentials and fails closed on missing or malformed documentation", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				),
		);
		const reader = new ApiModelCapabilities(fetcher as typeof fetch);
		expect(await reader.reasoning("fixture")).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(
			new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
		).toBe(false);
		expect(await reader.reasoning("../invalid")).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await new ApiModelCapabilities(
				vi.fn(async () => new Response("no", { status: 404 })) as typeof fetch,
			).reasoning("fixture"),
		).toEqual([]);
	});
});

const route = {
	id: "fixture",
	label: "Fixture",
	apiKey: "fixture-key",
	kind: "zdr" as const,
	enabled: true,
	priority: 0,
	visibleModels: ["fixture"],
	probeCapabilities: true,
};
it("strips inherited probe positives when their persisted model result is missing", async () => {
	const reader = new ApiModelCapabilities(async (_url, init) => {
		if (init?.method !== "POST") return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	}, () => 0);
	const models = await reader.enrich([{slug: "fixture", input_modalities: ["text", "image"]}], false, route);
	expect(models[0]?.service_tiers).not.toEqual([]);
	expect(models[0]?.capability_probe_status).toMatchObject({responses: "verified"});
	const [missing] = reader.applyPersistedProbes(models, route, []);
	expect(missing?.capability_probe_status).toEqual({responses: "unverified"});
	expect(missing?.capability_checked_at).toBeUndefined();
	expect(missing?.service_tiers).toBeUndefined();
	expect(missing?.default_service_tier).toBeUndefined();
	expect(missing?.additional_speed_tiers).toBeUndefined();
	expect(missing?.supported_reasoning_levels).toEqual([{effort: "low", description: "low reasoning effort"}]);
	expect(missing?.input_modalities).toEqual(["text", "image"]);
});

it("retains zero-time legacy loss across model and group eviction and another loss", async () => {
	let denied = false, posts = 0;
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		posts++;
		if (denied) return Response.json({error: {code: "invalid_api_key"}}, {status: 401});
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const reader = new ApiModelCapabilities(fetcher, () => 0);
	await reader.enrich([{slug: "fixture"}], false, route);
	denied = true;
	await reader.enrich([{slug: "fixture"}], true, route, true);
	const legacy = reader.exportProbes();
	const owner = legacy[0]![1].credentialOwner!;
	const restored = new ApiModelCapabilities(fetcher, () => 0);
	restored.importProbes(legacy);
	const others: Array<[string, number]> = Array.from({length: 999}, (_, index) => [index.toString(16).padStart(64, "0"), 0]);
	restored.importProbes(Array.from({length: 1000}, (_, index) => [`model-${index}`, {at: 0, levels: [], tiers: [], status: {responses: "verified"}}]), others);
	expect(restored.exportProbes().some(([, result]) => result.credentialOwner === owner)).toBe(false);
	denied = false;
	await restored.enrich([{slug: "other"}], false, {...route, id: "other", visibleModels: ["other"]});
	const roundTrip = new ApiModelCapabilities(fetcher, () => 0);
	roundTrip.importProbes(restored.exportProbes(), restored.exportOwnerLosses());
	const before = posts;
	const [hidden] = await roundTrip.enrich([{slug: "fixture"}], false, route);
	expect(posts).toBe(before);
	expect(hidden?.capability_probe_status).toMatchObject({responses: "unverified"});
	const [recovered] = await roundTrip.enrich([{slug: "fixture"}], true, route, true);
	expect(recovered?.capability_probe_status).toMatchObject({responses: "verified"});
	denied = true;
	const [lostAgain] = await roundTrip.enrich([{slug: "fixture"}], true, route, true);
	expect(lostAgain?.capability_probe_status).toMatchObject({responses: "unverified"});
	expect(roundTrip.exportOwnerLosses().find(([key]) => key === owner)?.[1]).toBeGreaterThan(0);
});

it("verifies API effort and equivalent fast tiers per credential and never treats a downgrade as fast", async () => {
	const calls: RequestInit[] = [];
	let now = 1;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST")
			return new Response("missing", { status: 404 });
		calls.push(init);
		const body = JSON.parse(String(init.body));
		if (body.service_tier === "ultrafast")
			return Response.json({ service_tier: "default" });
		if (body.service_tier === "priority")
			return Response.json({ service_tier: "priority" });
		if (!["low", "high"].includes(body.reasoning?.effort))
			return new Response("unsupported", { status: 400 });
		return Response.json({
			service_tier: "default",
			reasoning: body.reasoning,
		});
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.supported_reasoning_levels).toEqual(
		expect.arrayContaining([
			{ effort: "low", description: expect.any(String) },
			{ effort: "high", description: expect.any(String) },
		]),
	);
	expect(model?.service_tiers).toEqual([
		{ id: "priority", name: "Fast", description: expect.any(String) },
	]);
	expect(model?.capability_probe_status).toMatchObject({
		ultrafast: "downgraded",
		fast: "verified",
	});
	expect(
		calls.every(
			(c) =>
				new Headers(c.headers).get("authorization") === "Bearer fixture-key" &&
				JSON.parse(String(c.body)).store === false &&
				JSON.parse(String(c.body)).max_output_tokens === 16,
		),
	).toBe(true);
	const count = calls.length;
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(calls).toHaveLength(count);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		apiKey: "other-fixture-key",
	});
	expect(calls.length).toBeGreaterThan(count);
	now += 900001;
	await reader.enrich([{ slug: "fixture" }], false, route);
	expect(calls.length).toBeGreaterThan(count * 2);
});
it("never runs paid probes without opt-in and never calls an authentication failure unsupported", async () => {
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) =>
		i?.method === "POST"
			? new Response("unauthorized", { status: 401 })
			: new Response("missing", { status: 404 }),
	);
	const reader = new ApiModelCapabilities(fetcher as typeof fetch);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		probeCapabilities: false,
	});
	expect(fetcher.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.service_tiers).toEqual([]);
	expect(model?.capability_probe_status).toMatchObject({
		fast: "unverified",
		ultrafast: "unverified",
	});
});

it("coalesces concurrent paid probes for the same credential and model", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await Promise.all([
		reader.enrich([{ slug: "fixture" }], false, route),
		reader.enrich([{ slug: "fixture" }], false, route),
	]);
	expect(posts).toBe(9);
});

it("explicit checks bypass the paid-probe cache while automatic refreshes reuse it", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await reader.enrich([{ slug: "fixture" }], true, route);
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(posts).toBe(9);
	await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(posts).toBe(18);
});

it("runs independent probes concurrently with a shared four-request limit and stable effort ordering", async () => {
	let active = 0,
		peak = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST") return new Response("missing", { status: 404 });
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			const body = JSON.parse(String(i.body));
			return Response.json({
				reasoning: body.reasoning,
				service_tier: body.service_tier ?? "default",
			});
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(peak).toBe(4);
	expect(model?.supported_reasoning_levels).toEqual(
		["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
			(effort) => ({ effort, description: expect.any(String) }),
		),
	);
});

it("discovers newly entitled effort levels absent from documentation and excludes rejected levels", async () => {
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				);
			const body = JSON.parse(String(init.body));
			if (!body.service_tier && body.reasoning.effort === "xhigh")
				return Response.json({ reasoning: { effort: "xhigh" } });
			return Response.json(
				{
					error: {
						param: body.service_tier ? "service_tier" : "reasoning.effort",
					},
				},
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.supported_reasoning_levels).toEqual(
		["low", "medium", "high", "xhigh", "ultra"].map((effort) => ({
			effort,
			description: expect.any(String),
		})),
	);
	expect(model?.capability_probe_status).toMatchObject({
		"effort:xhigh": "verified",
		"effort:max": "unsupported",
	});
});

it("keeps native Ultra separate from API effort probes and maps it to a supported maximum", async () => {
	const calls: string[] = [];
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high, max.",
				);
			const body = JSON.parse(String(init.body));
			calls.push(body.reasoning?.effort);
			return Response.json(
				{ error: { param: "reasoning.effort" } },
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.supported_reasoning_levels).toContainEqual({
		effort: "ultra",
		description: expect.any(String),
	});
	expect(model?.multi_agent_reasoning_effort).toBe("max");
	expect(calls).not.toContain("ultra");
	expect(model?.capability_probe_status).not.toHaveProperty("effort:ultra");
	const [unknown] = await new ApiModelCapabilities(
		vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
	).enrich([{ slug: "fixture" }]);
	expect(unknown?.supported_reasoning_levels).toEqual([]);
	expect(unknown?.multi_agent_reasoning_effort).toBeNull();
});

it("reads newly named efforts from exact model documentation without accepting prose or control characters", () => {
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high, and deeper_v2.",
		),
	).toEqual(["low", "high", "deeper_v2"]);
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high depending on access.",
		),
	).toEqual([]);
});

it("checks Responses tool compatibility before advertising an explicitly rejected API model", async () => {
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools)
			return Response.json(
				{ error: { code: "model_not_found", param: "model" } },
				{ status: 404 },
			);
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.capability_probe_status).toMatchObject({
		responses: "unsupported",
	});
	const { buildVisibleModelUnion, resolveModelRoute } = await import(
		"../lib/model-route-policy.js"
	);
	const catalog = {
		id: "fixture",
		kind: "zdr" as const,
		enabled: true,
		priority: 0,
		visibleModels: ["fixture"],
		models: [model!],
	};
	expect(buildVisibleModelUnion([catalog])).toEqual([]);
	expect(resolveModelRoute("zdr/fixture", [catalog]).candidates).toEqual([]);
});

it("verifies a tool call with a tiny benign payload and reports it in check entitlements", async () => {
	let probe: Record<string, unknown> | undefined;
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools) {
			probe = body;
			return Response.json({
				output: [
					{ type: "function_call", name: "capability_probe", arguments: "{}" },
				],
			});
		}
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(probe).toMatchObject({
		store: false,
		max_output_tokens: 16,
		tool_choice: { type: "function", name: "capability_probe" },
	});
	const { modelEntitlements } = await import("../lib/model-route-policy.js");
	expect(modelEntitlements(model!).probes).toMatchObject({
		responses: "verified",
	});
});

it("preserves established efforts across a documentation outage",async()=>{
 let now=1000;
 const fetcher=vi.fn(async()=>new Response("Model ID: `fixture`\nReasoning.effort supports: low, medium, high."));
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 expect(await reader.reasoning("fixture")).toContain("medium");
 now+=61000;fetcher.mockResolvedValue(new Response("unavailable",{status:503}));
 expect(await reader.reasoning("fixture")).toContain("medium");
});
it("probes the exact priority tier exposed by the native picker",async()=>{
 const tiers:string[]=[];
 const fetcher=vi.fn(async (_url:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
  const body=JSON.parse(String(init.body));if(body.service_tier)tiers.push(body.service_tier);
  if(body.service_tier==='fast')return Response.json({error:{code:'invalid_value',param:'service_tier'}},{status:400});
  return Response.json({service_tier:body.service_tier??'default'});
 });
 const reader=new ApiModelCapabilities(fetcher as typeof fetch);
 const [model]=await reader.enrich([{slug:'fixture'}],false,{id:'fixture',kind:'zdr',label:'Fixture',enabled:true,priority:9,apiKey:'fixture-key',visibleModels:['fixture'],probeCapabilities:true});
 expect(tiers).toContain('priority');expect(tiers).not.toContain('fast');
 expect(model?.service_tiers).toEqual(expect.arrayContaining([expect.objectContaining({id:'priority'})]));
});

it("advertises documented image input on API and ZDR aliases using the existing metadata fetch", async () => {
 const fetcher = vi.fn(async () => new Response("Model ID: `fixture`\nReasoning.effort supports: low, high.\n\n## Model details\n\n- Input modalities: text, image\n- Output modalities: text\n\n## Pricing\n"));
 const reader = new ApiModelCapabilities(fetcher as typeof fetch);
 const { apiPickerModel } = await import("../lib/runtime/api-model-runtime.js");
 const { buildVisibleModelUnion } = await import("../lib/model-route-policy.js");
 const models = await reader.enrich([apiPickerModel("fixture")]);
 expect(models[0]?.input_modalities).toEqual(["text", "image"]);
 const aliases = buildVisibleModelUnion(["api", "zdr"].map(kind => ({...route, kind:kind as "api"|"zdr", models, probeCapabilities:false})));
 expect(aliases).toHaveLength(2);
 expect(aliases.every(model => Array.isArray(model.input_modalities) && model.input_modalities.includes("image"))).toBe(true);
 expect(await reader.reasoning("fixture")).toEqual(["low", "high"]);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
});

it.each([
 "Model ID: `other`\n\n## Model details\n- Input modalities: text, image\n",
 "Model ID: `fixture`\n\n## Model details\n- Input modalities: text\n- Output modalities: image\n",
 "Model ID: `fixture`\n\n## Examples\n- Input modalities: text, image\n",
 "Model ID: `fixture`\n\n## Model details\n- Input modalities: text, image depending on access\n",
])("does not infer image input from other models, output support, examples, or ambiguous prose", async doc => {
 const reader = new ApiModelCapabilities(vi.fn(async () => new Response(doc)) as typeof fetch);
 const [model] = await reader.enrich([{slug:"fixture", input_modalities:["text"]}]);
 expect(model?.input_modalities).toEqual(["text"]);
});

it("retains documented image support through a metadata outage and adopts an explicit text-only update", async () => {
 let now=1000;
 const fetcher=vi.fn(async()=>new Response("Model ID: `fixture`\n\n## Model details\n- Input modalities: text, image\n"));
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 const input=[{slug:"fixture", input_modalities:["text"]}];
 expect((await reader.enrich(input))[0]?.input_modalities).toContain("image");
 now+=61000;
 fetcher.mockResolvedValue(new Response("unavailable",{status:503}));
 expect((await reader.enrich(input))[0]?.input_modalities).toContain("image");
 fetcher.mockResolvedValue(new Response("Model ID: `fixture`\n\n## Model details\n- Input modalities: text\n"));
 expect((await reader.enrich(input,true))[0]?.input_modalities).toEqual(["text"]);
});

it("keeps verified efforts and speed tiers through a throttled re-probe and retries it soon", async () => {
	let now = 1;
	let throttled = false;
	let posts = 0;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		posts++;
		if (throttled) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 });
		const body = JSON.parse(String(init.body));
		if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
		if (body.service_tier === "priority") return Response.json({ service_tier: "priority" });
		if (body.service_tier) return Response.json({ service_tier: "default" });
		return Response.json({ service_tier: "default", reasoning: body.reasoning });
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const efforts = async () => ((await reader.enrich([{ slug: "fixture" }], false, route))[0]);
	const first = await efforts();
	expect(first?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
	expect(first?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	throttled = true;
	now += 900_001;
	const second = await efforts();
	expect(second?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
	expect(second?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	// Not trusted as fresh for 15 minutes: a minute later it probes again.
	const afterThrottle = posts;
	now += 60_001;
	await efforts();
	expect(posts).toBeGreaterThan(afterThrottle);
});

it("stops advertising a credential's verified settings once it loses access", async () => {
	let now = 1;
	let revoked = false;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("missing", { status: 404 });
		if (revoked) return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
		const body = JSON.parse(String(init.body));
		if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
		if (body.service_tier === "priority") return Response.json({ service_tier: "priority" });
		if (body.service_tier) return Response.json({ service_tier: "default" });
		return Response.json({ service_tier: "default", reasoning: body.reasoning });
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const enrich = async () => (await reader.enrich([{ slug: "fixture" }], false, route))[0];
	expect((await enrich())?.service_tiers).toEqual([expect.objectContaining({ id: "priority" })]);
	revoked = true;
	now += 900_001;
	const after = await enrich();
	expect(after?.service_tiers).toEqual([]);
	expect(after?.supported_reasoning_levels ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ effort: "xhigh" })]));
});

it.each([401, 403].flatMap(status => [false, true].flatMap(previous => [false, true].map(revocationFirst => ({status, previous, revocationFirst})))))
("removes every probe-derived positive after late credential loss (%j)", async ({status, previous, revocationFirst}) => {
	let now = 1, denying = !previous;
	let releaseFast: () => void = () => undefined, releaseRevocation: () => void = () => undefined;
	let entered: () => void = () => undefined, finishedFirst: () => void = () => undefined;
	const fastGate = new Promise<void>(resolve => {releaseFast = resolve;});
	const revocationGate = new Promise<void>(resolve => {releaseRevocation = resolve;});
	const started = new Promise<void>(resolve => {entered = resolve;});
	const firstFinished = new Promise<void>(resolve => {finishedFirst = resolve;});
	let waiting = 0;
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		if (init?.method !== "POST") return new Response("Model ID: `fixture`\n`reasoning.effort` supports low, high.");
		const body = JSON.parse(String(init.body));
		if (denying && body.service_tier) {
			if (++waiting === 2) entered();
			const revoked = body.service_tier === "ultrafast";
			await (revoked ? revocationGate : fastGate);
			const response = revoked
				? Response.json({error: {code: status === 401 ? "invalid_api_key" : "permission_denied"}}, {status})
				: Response.json({service_tier: "priority"});
			if (revoked === revocationFirst) {
				const stream = response.body!;
				const getReader = stream.getReader.bind(stream);
				vi.spyOn(stream, "getReader").mockImplementation(() => {
					const reader = getReader();
					const cancel = reader.cancel.bind(reader);
					vi.spyOn(reader, "cancel").mockImplementation(async reason => {await cancel(reason); finishedFirst();});
					return reader;
				});
			}
			return response;
		}
		if (body.tools) return Response.json({output: [{type: "function_call", name: "capability_probe"}]});
		return Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	});
	const reader = new ApiModelCapabilities(fetcher, () => now);
	const enrich = async () => (await reader.enrich([{slug: "fixture"}], false, route))[0];
	if (previous) {
		expect((await enrich())?.service_tiers).toEqual(expect.arrayContaining([expect.objectContaining({id: "priority"})]));
		denying = true; now += 900001;
	}
	const pending = enrich();
	await started;
	(revocationFirst ? releaseRevocation : releaseFast)();
	await firstFinished;
	(revocationFirst ? releaseFast : releaseRevocation)();
	const model = await pending;
	expect(model?.service_tiers).toEqual([]);
	expect(model?.additional_speed_tiers).toEqual([]);
	expect(model?.supported_reasoning_levels).toEqual([
		{effort: "low", description: "low reasoning effort"},
		{effort: "high", description: "high reasoning effort"},
		{effort: "ultra", description: "Proactive multi-agent mode using a supported API reasoning effort"},
	]);
	expect(Object.values(model?.capability_probe_status ?? {})).not.toContain("verified");
	expect(model?.capability_probe_status).toMatchObject({responses: "unverified", retry: "transient"});
	const posts = fetcher.mock.calls.length;
	expect(JSON.parse(JSON.stringify(await enrich()))).toEqual(JSON.parse(JSON.stringify(model)));
	expect(fetcher.mock.calls).toHaveLength(posts);
});

it.each([401, 403].flatMap(status => [false, true].map(imported => ({status, imported}))))
("clears cross-model cached and exported positives after credential-wide loss (%j)", async ({status, imported}) => {
	let lost = false;
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		const body = JSON.parse(String(init.body));
		if (lost && body.model === "Y") return Response.json({error: {code: status === 401 ? "invalid_api_key" : "permission_denied"}}, {status});
		if (body.tools) return Response.json({output: [{type: "function_call", name: "capability_probe"}]});
		return Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	let reader = new ApiModelCapabilities(fetcher, () => 1);
	expect((await reader.enrich([{slug: "X"}], false, route))[0]?.service_tiers).not.toEqual([]);
	if (imported) {
		const exported = reader.exportProbes();
		reader = new ApiModelCapabilities(fetcher, () => 1);
		reader.importProbes(exported);
	}
	const independent = {...route, apiKey: "independent-fixture-key"};
	expect((await reader.enrich([{slug: "X"}], false, independent))[0]?.service_tiers).not.toEqual([]);
	lost = true;
	const results = await reader.enrich([{slug: "X"}, {slug: "Y"}], false, route);
	for (const model of results) {
		expect(model.service_tiers).toEqual([]);
		expect(model.supported_reasoning_levels).toEqual([]);
		expect(Object.values(model.capability_probe_status as Record<string, string>)).not.toContain("verified");
	}
	expect((await reader.enrich([{slug: "X"}], false, independent))[0]?.service_tiers).not.toEqual([]);
	const restored = new ApiModelCapabilities(fetcher, () => 1);
	restored.importProbes(reader.exportProbes());
	expect((await restored.enrich([{slug: "X"}], false, route))[0]?.service_tiers).toEqual([]);
	expect((await restored.enrich([{slug: "X"}], false, independent))[0]?.service_tiers).not.toEqual([]);
	expect((await reader.enrich([{slug: "X"}], false, {...route, apiKey: "recovered-fixture-key"}))[0]?.service_tiers).not.toEqual([]);
});

it.each([401, 403].flatMap(status => [false, true].map(positiveFirst => ({status, positiveFirst}))))
("discards cross-model positives completing before or after credential loss (%j)", async ({status, positiveFirst}) => {
	let releaseX: () => void = () => undefined, releaseY: () => void = () => undefined;
	let enteredX: () => void = () => undefined, enteredY: () => void = () => undefined;
	const xGate = new Promise<void>(resolve => {releaseX = resolve;});
	const yGate = new Promise<void>(resolve => {releaseY = resolve;});
	const xReady = new Promise<void>(resolve => {enteredX = resolve;});
	const yReady = new Promise<void>(resolve => {enteredY = resolve;});
	const fetcher: typeof fetch = async (url, init) => {
		if (init?.method !== "POST") {
			const id = String(url).split("/").at(-1)?.replace(".md", "");
			return new Response(`Model ID: \`${id}\`\n\`reasoning.effort\` supports none, minimal, low, medium, high, xhigh, max.`);
		}
		const body = JSON.parse(String(init.body));
		if (body.model === "Y") {enteredY(); await yGate; return Response.json({error: {code: status === 401 ? "invalid_api_key" : "permission_denied"}}, {status});}
		if (body.tools) {enteredX(); await xGate; return Response.json({output: [{type: "function_call", name: "capability_probe"}]});}
		return Response.json({service_tier: body.service_tier});
	};
	const reader = new ApiModelCapabilities(fetcher, () => 1);
	const x = reader.enrich([{slug: "X"}], false, route);
	const y = reader.enrich([{slug: "Y"}], false, route);
	await Promise.all([xReady, yReady]);
	if (positiveFirst) {releaseX(); expect((await x)[0]?.service_tiers).not.toEqual([]); releaseY(); await y;}
	else {releaseY(); await y; releaseX(); await x;}
	const [model] = await reader.enrich([{slug: "X"}], false, route);
	expect(model?.service_tiers).toEqual([]);
	expect(Object.values(model?.capability_probe_status as Record<string, string>)).not.toContain("verified");
	expect(model?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({effort: "high"})]));
	for (const [, result] of reader.exportProbes()) expect(Object.values(result.status)).not.toContain("verified");
});

it("retains independent imported credential evidence after an attributed loss", async () => {
	let revoked = false, posts = 0, now = 1000;
	const other = {...route, id: "independent", apiKey: "independent-key"};
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		posts++;
		if (revoked) return Response.json({error: {code: "invalid_api_key"}}, {status: 401});
		const body = JSON.parse(String(init.body));
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default"});
	};
	const first = new ApiModelCapabilities(fetcher, () => now);
	await first.enrich([{slug: "X"}], false, route);
	await first.enrich([{slug: "X"}], false, other);
	const imported = new ApiModelCapabilities(fetcher, () => now);
	imported.importProbes(first.exportProbes());
	revoked = true; now = 3000;
	await imported.enrich([{slug: "Y"}], false, route);
	const before = posts;
	const [independent] = await imported.enrich([{slug: "X"}], false, other);
	expect(posts).toBe(before);
	expect(independent?.service_tiers).not.toEqual([]);
	expect(independent?.capability_probe_status).toMatchObject({responses: "verified"});
	const changed = imported.exportProbes().filter(([, result]) => !Object.values(result.status).includes("verified"));
	expect(changed).toHaveLength(2);
	for (const [, result] of changed) expect(result.at).toBe(3000);
});

it.each([false, true])("retires held and queued probes without letting old results harm the fresh owner (denied=%s)", async denied => {
	let entered: () => void = () => undefined, release: () => void = () => undefined, posts = 0, oldPosts = 0, fresh = false;
	const ready = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
	const reader = new ApiModelCapabilities(async (_url, init) => {
		if (init?.method !== "POST") return new Response("missing", {status: 404});
		const body = JSON.parse(String(init.body));
		const old = body.model !== "new"; posts++;
		if (old) oldPosts++;
		if (old && posts === 1) {entered(); await gate;}
		if (old && fresh && !denied || !old && denied) return Response.json({error: {code: "invalid_api_key"}}, {status: 401});
		return Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default", output: [{type: "function_call", name: "capability_probe"}]});
	}, () => fresh ? 2000 : 1000);
	const pending = reader.enrich([{slug: "old"}, {slug: "queued"}], false, route);
	await ready;
	try {
		const alreadySent = oldPosts;
		fresh = true;
		const [current] = await reader.enrich([{slug: "new"}], false, route, true);
		expect(oldPosts).toBe(alreadySent);
		expect(current?.capability_probe_status).toMatchObject({responses: denied ? "unverified" : "verified"});
		const exported = reader.exportProbes(), before = posts;
		release();
		const old = await pending;
		expect(posts).toBe(before);
		for (const model of old) {
			expect(model.service_tiers).toEqual([]);
			expect(isRecord(model.capability_probe_status)).toBe(true);
			if (isRecord(model.capability_probe_status)) expect(Object.values(model.capability_probe_status)).not.toContain("verified");
		}
		expect(reader.exportProbes()).toEqual(exported);
	} finally {release(); await pending;}
});

it("forces a fresh healthy batch instead of sharing an earlier in-flight probe", async () => {
	let entered!: () => void, release!: () => void, posts = 0;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method !== "POST") return new Response("Model ID: `fixture`\nReasoning.effort supports: low.");
		if (++posts === 1) {entered(); await gate;}
		const body = JSON.parse(String(init.body));
		return Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default", output: [{type: "function_call", name: "capability_probe"}]});
	};
	const reader = new ApiModelCapabilities(fetcher);
	const older = reader.enrich([{slug: "fixture"}], false, route);
	await ready;
	try {
		let finished = false;
		const fresh = reader.enrich([{slug: "fixture"}], false, route, true).then(result => {finished = true; return result;});
		await vi.waitFor(() => expect(finished).toBe(true));
		expect((await fresh)[0]?.capability_probe_status).toMatchObject({responses: "verified", fast: "verified"});
	} finally {release(); await older;}
});

it("does not let a retired documentation-delayed batch mutate newer cached positives", async () => {
	let now = 1, blockDoc = false, revoked = false;
	let entered!: () => void, release!: () => void;
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const gate = new Promise<void>(resolve => {release = resolve;});
	const reader = new ApiModelCapabilities(async (_url, init) => {
		if (init?.method !== "POST") {
			if (blockDoc) {blockDoc = false; entered(); await gate;}
			return new Response("missing", {status: 404});
		}
		if (revoked) return Response.json({error: {code: "invalid_api_key"}}, {status: 401});
		const body = JSON.parse(String(init.body));
		return Response.json({reasoning: body.reasoning, service_tier: body.service_tier ?? "default", output: [{type: "function_call", name: "capability_probe"}]});
	}, () => now);
	await reader.enrich([{slug: "fixture"}], false, route);
	now = 900002; blockDoc = true;
	const older = reader.enrich([{slug: "fixture"}], true, route);
	await ready;
	try {
		revoked = true; await reader.enrich([{slug: "denied"}], false, route);
		now++; revoked = false;
		const fresh = (await reader.enrich([{slug: "fixture"}], false, route, true))[0];
		expect(fresh?.capability_probe_status).toMatchObject({"effort:low": "verified"});
		const exported = reader.exportProbes();
		release(); await older;
		expect(reader.exportProbes()).toEqual(exported);
		expect((await reader.enrich([{slug: "fixture"}], false, route))[0]?.capability_probe_status).toMatchObject({"effort:low": "verified"});
	} finally {release(); await older;}
});

it("forces a fresh restored generation without borrowing or reviving denied inflight work", async () => {
	let now = 1000, restored = false, release: () => void = () => undefined, entered: () => void = () => undefined, posts = 0;
	const gate = new Promise<void>(resolve => {release = resolve;});
	const ready = new Promise<void>(resolve => {entered = resolve;});
	const fetcher: typeof fetch = async (url, init) => {
		if (init?.method !== "POST") {
			const id = String(url).split("/").at(-1)?.replace(".md", "");
			return new Response(`Model ID: \`${id}\`\n\`reasoning.effort\` supports none, minimal, low, medium, high, xhigh, max.`);
		}
		posts++;
		const body = JSON.parse(String(init.body));
		if (!restored && body.model === "X") {entered(); await gate;}
		if (!restored && body.model === "Y") return Response.json({error: {code: "permission_denied"}}, {status: 403});
		return body.tools ? Response.json({output: [{type: "function_call", name: "capability_probe"}]}) : Response.json({service_tier: body.service_tier});
	};
	const reader = new ApiModelCapabilities(fetcher, () => now);
	const old = reader.enrich([{slug: "X"}], false, route);
	await ready;
	now = 2000;
	await reader.enrich([{slug: "Y"}], false, route);
	const lostPosts = posts;
	await reader.enrich([{slug: "Y"}], false, route);
	expect(posts).toBe(lostPosts);
	restored = true; now = 3000;
	const currentBatch = reader.enrich([{slug: "X"}], false, route, true);
	try {
		await vi.waitFor(() => expect(posts).toBeGreaterThan(lostPosts));
		const [current] = await currentBatch;
		expect(current?.capability_probe_status).toMatchObject({responses: "verified"});
		expect(current?.service_tiers).not.toEqual([]);
	} finally {release();}
	const [late] = await old;
	expect(late?.service_tiers).toEqual([]);
	expect(Object.values(late?.capability_probe_status as Record<string, string>)).not.toContain("verified");
	expect(late?.capability_checked_at).toBe(2000);
	const again = await reader.enrich([{slug: "X"}], false, route);
	expect(again[0]?.capability_probe_status).toMatchObject({responses: "verified"});
	expect(again[0]?.capability_checked_at).toBe(3000);
});

it("a setting-specific 403 removes only the denied effort", async () => {
 let now=1, deny=false;
 const fetcher=vi.fn(async (_u:unknown, init?:RequestInit)=>{
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(deny && body.reasoning?.effort==="xhigh") return Response.json({error:{code:"unsupported_value",param:"reasoning.effort"}},{status:403});
  if(body.tools)return Response.json({output:[{type:"function_call",name:"capability_probe"}]});
  return Response.json({reasoning:body.reasoning,service_tier:body.service_tier??"default"});
 });
 const reader=new ApiModelCapabilities(fetcher as typeof fetch,()=>now);
 await reader.enrich([{slug:"fixture"}],false,route);
 deny=true;now+=900001;
 const [model]=await reader.enrich([{slug:"fixture"}],false,route);
 expect(model?.supported_reasoning_levels).toEqual(expect.arrayContaining([expect.objectContaining({effort:"high"})]));
 expect(model?.supported_reasoning_levels).not.toEqual(expect.arrayContaining([expect.objectContaining({effort:"xhigh"})]));
 expect(model?.service_tiers).toEqual(expect.arrayContaining([expect.objectContaining({id:"priority"})]));
});

describe("403 probe outcomes", () => {
	const run = async (deny: (body: Record<string, unknown>) => Response | null) => {
		let now = 1;
		let denying = false;
		let posts = 0;
		const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST") return new Response("missing", { status: 404 });
			posts++;
			const body = JSON.parse(String(init.body));
			const denied = denying ? deny(body) : null;
			if (denied) return denied;
			if (body.tools) return Response.json({ output: [{ type: "function_call", name: "capability_probe" }] });
			return Response.json({ reasoning: body.reasoning, service_tier: body.service_tier ?? "default" });
		});
		const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
		await reader.enrich([{ slug: "fixture" }], false, route);
		denying = true;
		now += 900_001;
		const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
		const efforts = (model?.supported_reasoning_levels as { effort: string }[] | undefined ?? []).map((level) => level.effort);
		const tiers = (model?.service_tiers as { id: string }[] | undefined ?? []).map((tier) => tier.id);
		const before = posts;
		now += 60_001;
		await reader.enrich([{ slug: "fixture" }], false, route);
		return { efforts, tiers, status: (model?.capability_probe_status ?? {}) as Record<string, string>, reprobedSoon: posts > before };
	};
	it("drops everything the credential verified on a 403 that names the key or project", async () => {
		const result = await run(() => Response.json({ error: { code: "insufficient_permissions", message: "fixture" } }, { status: 403 }));
		expect(result.efforts).not.toContain("xhigh");
		expect(result.tiers).toEqual([]);
	});
	it("hides the whole model on this credential after a model-entitlement 403", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh"
			? Response.json({ error: { code: "model_access_denied", message: "fixture" } }, { status: 403 })
			: null);
		expect(result.efforts).toEqual([]);
		expect(result.tiers).toEqual([]);
		expect(result.status.responses).toBe("unsupported");
		expect(result.reprobedSoon).toBe(false);
	});
	it("removes only the named effort on a 403 whose param is the probed setting", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh" && !body.tools && !body.service_tier
			? Response.json({ error: { code: "unsupported_value", param: "reasoning.effort" } }, { status: 403 })
			: null);
		expect(result.efforts).not.toContain("xhigh");
		expect(result.efforts).toContain("high");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.reprobedSoon).toBe(false);
	});
	it("does not treat an effort-param 403 on the compatibility or tier probes as a denial of what they test", async () => {
		const result = await run((body) => body.tools || body.service_tier
			? Response.json({ error: { code: "forbidden", param: "reasoning.effort" } }, { status: 403 })
			: null);
		expect(result.status.responses).not.toBe("unsupported");
		expect(result.status.fast).not.toBe("unsupported");
		expect(result.status.ultrafast).not.toBe("unsupported");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.efforts).toContain("xhigh");
		expect(result.reprobedSoon).toBe(true);
	});
	it("changes nothing on an unexplained 403 and retries the probe soon", async () => {
		const result = await run((body) => (body.reasoning as { effort?: string } | undefined)?.effort === "xhigh" && !body.service_tier && !body.tools
			? new Response("denied", { status: 403 })
			: null);
		expect(result.efforts).toContain("xhigh");
		expect(result.efforts).toContain("high");
		expect(result.tiers).toEqual(expect.arrayContaining(["priority", "ultrafast"]));
		expect(result.reprobedSoon).toBe(true);
	});
});

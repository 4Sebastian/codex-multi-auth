import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("usage ledger core", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-usage-ledger-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("appends normalized JSONL rows without raw email or account identifiers", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
		} = await import("../lib/usage/index.js");

		const row = await appendUsageLedgerRow({
			id: "row-1",
			createdAt: 1_700_000_000_000,
			source: "runtime-proxy",
			operation: "responses",
			outcome: "success",
			model: " gpt-5.3-codex ",
			accountId: "acct_sensitive_123",
			email: "Owner@Example.com",
			accountIndex: 2,
			requestId: "req_123",
			statusCode: 200,
			durationMs: 123.9,
			inputTokens: 1_000,
			outputTokens: 200,
			cachedInputTokens: 50,
			reasoningTokens: 25,
		});

		expect(row.model).toBe("gpt-5.3-codex");
		expect(row.account?.accountHash).toMatch(/^sha256:/);
		expect(row.account?.emailHash).toMatch(/^sha256:/);
		expect(row.account?.index).toBe(2);
		expect(row.tokens.totalTokens).toBe(1_225);
		expect(row.tokens.cachedInputTokens).toBe(50);
		expect(row.costUsd).toBeGreaterThan(0);

		const raw = await fs.readFile(getUsageLedgerPaths().current, "utf8");
		expect(raw).toContain('"version":1');
		expect(raw).not.toContain("acct_sensitive_123");
		expect(raw).not.toContain("Owner@Example.com");
		expect(raw).not.toContain("owner@example.com");

		await expect(readUsageLedgerRows()).resolves.toEqual([row]);
	});

	it("round-trips image accounting without storing request bodies or raw identity", async () => {
		const { appendUsageLedgerRow, readUsageLedgerRows, getUsageLedgerPaths } = await import("../lib/usage/index.js");
		const row = await appendUsageLedgerRow({
			source: "runtime-proxy", operation: "images", outcome: "success",
			model: "gpt-image-2", statusCode: 200, accountId: "synthetic-image-account",
			email: "image@example.test", accountIndex: 0,
		});
		expect(row.operation).toBe("images");
		await expect(readUsageLedgerRows()).resolves.toEqual([row]);
		const raw = await fs.readFile(getUsageLedgerPaths().current, "utf8");
		expect(raw).not.toContain("synthetic-image-account");
		expect(raw).not.toContain("image@example.test");
		expect(raw).not.toContain("b64_json");
	});

	it("summarizes usage by model and applies date filters", async () => {
		const { appendUsageLedgerRow, summarizeUsageLedger } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({
			id: "old",
			createdAt: 100,
			outcome: "success",
			model: "gpt-5.3-codex",
			inputTokens: 100,
			outputTokens: 10,
		});
		await appendUsageLedgerRow({
			id: "new-success",
			createdAt: 200,
			outcome: "success",
			model: "gpt-5.3-codex",
			inputTokens: 200,
			outputTokens: 20,
		});
		await appendUsageLedgerRow({
			id: "new-failure",
			createdAt: 300,
			outcome: "failure",
			model: "gpt-5.5",
			inputTokens: 50,
			outputTokens: 5,
		});

		const summary = await summarizeUsageLedger({ since: 150, by: "model" });

		expect(summary.totals.requests).toBe(2);
		expect(summary.totals.successes).toBe(1);
		expect(summary.totals.failures).toBe(1);
		expect(summary.totals.inputTokens).toBe(250);
		expect(summary.buckets.map((bucket) => bucket.key)).toEqual([
			"gpt-5.3-codex",
			"gpt-5.5",
		]);
		expect(summary.buckets[0]?.requests).toBe(1);
	});

	it("rotates the current ledger and can include archived rows", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
			rotateUsageLedger,
		} = await import("../lib/usage/index.js");

		await appendUsageLedgerRow({
			id: "before-rotate",
			createdAt: 100,
			outcome: "success",
			model: "gpt-5.3-codex",
		});
		const lockPath = `${getUsageLedgerPaths().current}.lock`;
		await fs.writeFile(lockPath, "stale\n", "utf8");
		const staleDate = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		const rotated = await rotateUsageLedger({
			now: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
		});

		expect(rotated).toContain("usage-ledger.20260102T030405006Z.jsonl");
		await expect(fs.stat(lockPath)).rejects.toThrow();
		await expect(fs.stat(getUsageLedgerPaths().current)).rejects.toThrow();

		await appendUsageLedgerRow({
			id: "after-rotate",
			createdAt: 200,
			outcome: "success",
			model: "gpt-5.5",
		});

		expect((await readUsageLedgerRows()).map((row) => row.id)).toEqual([
			"after-rotate",
		]);
		expect(
			(await readUsageLedgerRows({ includeArchives: true })).map(
				(row) => row.id,
			),
		).toEqual(["before-rotate", "after-rotate"]);
	});

	it("skips rotation when below the configured byte threshold", async () => {
		const { appendUsageLedgerRow, rotateUsageLedger } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({
			id: "small",
			createdAt: 100,
			outcome: "success",
		});

		await expect(
			rotateUsageLedger({ ifLargerThanBytes: 1_000_000 }),
		).resolves.toBeNull();
	});

	it("retries transient lock close failures before removing the lock", async () => {
		const realOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open");
		openSpy.mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			let closeAttempts = 0;
			return new Proxy(handle, {
				get(target, property, receiver) {
					if (property === "close") {
						return async () => {
							closeAttempts += 1;
							if (closeAttempts === 1) {
								throw Object.assign(new Error("close busy"), { code: "EBUSY" });
							}
							return target.close();
						};
					}
					return Reflect.get(target, property, receiver);
				},
			}) as Awaited<ReturnType<typeof fs.open>>;
		});
		const { appendUsageLedgerRow, getUsageLedgerPaths } = await import(
			"../lib/usage/index.js"
		);

		await appendUsageLedgerRow({ id: "close-retry", outcome: "success" });

		const paths = getUsageLedgerPaths();
		await expect(fs.access(`${paths.current}.lock`)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it.each((["api", "zdr"] as const).flatMap(kind => ["", "speed/fast/", "speed/ultrafast/"].flatMap(speed => ["gpt-5.5-pro", "gpt-6-astra"].map(model => ({kind, speed, model})))))
	("prices the actual API payload and persisted usage without OAuth replacement: %j", async ({kind, speed, model}) => {
		const {ApiModelRuntime} = await import("../lib/runtime/api-model-runtime.js");
		const {appendUsageLedgerRow, readUsageLedgerRows, summarizeUsageRows, extractResponsesUsage} = await import("../lib/usage/index.js");
		const {evaluateBudgetGuard} = await import("../lib/budget-guard.js");
		const sent: unknown[] = [];
		const runtime = new ApiModelRuntime(async (_url, init) => {
			if (init?.method !== "POST") return Response.json({data: [{id: model}]});
			sent.push(JSON.parse(String(init.body)));
			return Response.json({service_tier: speed === "speed/fast/" ? "priority" : speed ? "ultrafast" : "default", usage: {input_tokens: 1000, output_tokens: 100, total_tokens: 1100}});
		}, Date.now, undefined, async models => models.map(item => ({...item, service_tiers: [{id: "priority", name: "Fast", description: "Fixture"}, {id: "ultrafast", name: "Ultrafast", description: "Fixture"}]})));
		const alias = `${kind}/${speed}${model}`;
		const {saveApiRoutes} = await import("../lib/api-route-store.js");
		const routes = [{id: "priced-fixture", label: "Fixture", kind, apiKey: "fixture-key", enabled: true, priority: 0, visibleModels: [model]}];
		await saveApiRoutes(routes);
		const response = await runtime.request(alias, {model: alias, input: "Fixture"}, routes);
		expect(response.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({model, store: false, ...(speed ? {service_tier: speed === "speed/fast/" ? "priority" : "ultrafast"} : {})});
		const usage = extractResponsesUsage(await response.json());
		expect(usage).toMatchObject({inputTokens: 1000, outputTokens: 100, totalTokens: 1100});
		const row = await appendUsageLedgerRow({id: "actual-api-model", source: "runtime-proxy", operation: "responses", outcome: "success", model: alias, ...usage});
		const cost = model === "gpt-5.5-pro" || speed === "speed/ultrafast/" ? null : speed ? 0.03 : 0.015;
		expect(row.costUsd).toBe(cost);
		const persisted = (await readUsageLedgerRows()).filter(item => item.id === row.id);
		expect(persisted).toEqual([row]);
		const budget = evaluateBudgetGuard({key: "*", window: "day", maxCostUsd: 1, updatedAt: 1}, summarizeUsageRows(persisted));
		expect(budget.allowed).toBe(cost !== null);
		expect(budget.usage.unpricedRequests).toBe(cost === null ? 1 : 0);
		if (cost === null) expect(budget.reasons.join(" ")).toContain("cost limit cannot be evaluated");
	});

	it("keeps malformed and prototype API prices unknown and historical costs unchanged", async () => {
		const {getUsageModelPricing, appendUsageLedgerRow, readUsageLedgerRows, estimateUsageCostUsd} = await import("../lib/usage/index.js");
		for (const model of ["api/constructor", "zdr/toString", "api/speed/fast/__proto__", "api/speed/fast/", "api/zdr/gpt-6-astra", "api/speed/fast/zdr/gpt-6-astra", "api/astra", "api/gpt-6.2-sol"]) expect(getUsageModelPricing(model)).toBeNull();
		expect(estimateUsageCostUsd("gpt-5.5-pro", {inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 1100})).toBe(0.015);
		const historical = await appendUsageLedgerRow({id: "historical-api-price", model: "api/gpt-5.5-pro", inputTokens: 1000, outputTokens: 100, costUsd: 0.123, outcome: "success"});
		expect(historical.costUsd).toBe(0.123);
		expect((await readUsageLedgerRows()).find(row => row.id === historical.id)?.costUsd).toBe(0.123);
	});

	it("exports pricing helpers with deterministic estimates", async () => {
		const { estimateUsageCostUsd, getUsageModelPricing, listUsageModelPricing } =
			await import("../lib/usage/index.js");

		expect(Object.keys(listUsageModelPricing())).toContain("gpt-6.1-sol");
		// Bare aliases reach the ledger raw (the proxy records the client's model
		// string verbatim) but price through their canonical card — an unresolved
		// alias would read as unpriced and fail a cost budget closed.
		expect(getUsageModelPricing("gpt-6.1")).toEqual(
			getUsageModelPricing("gpt-6.1-sol"),
		);
		expect(getUsageModelPricing("gpt-6")).toEqual(
			getUsageModelPricing("gpt-6-astra"),
		);
		expect(getUsageModelPricing("gpt-5.6")).toEqual(
			getUsageModelPricing("gpt-5.6-sol"),
		);
		expect(getUsageModelPricing("gpt-6.1-sol-max")).toEqual(
			getUsageModelPricing("gpt-6.1-sol"),
		);
		expect(
			estimateUsageCostUsd("gpt-6.1", {
				inputTokens: 100_000,
				outputTokens: 1_000_000,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 1_100_000,
			}),
		).toBeCloseTo(10.2, 10);
		// Unknown ids still price as unknown rather than at the default's rate.
		expect(getUsageModelPricing("gpt-6.2-sol")).toBeNull();
		// Retired gpt-5.5 prices through its replacement card (gpt-6-sol);
		// 1M input crosses the 272K long-context threshold ($4/$15/$0.40).
		expect(
			estimateUsageCostUsd("gpt-5.5", {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cachedInputTokens: 1_000_000,
				reasoningTokens: 1_000_000,
				totalTokens: 4_000_000,
			}),
		).toBe(30.4);
		expect(
			estimateUsageCostUsd("gpt-5.5", {
				inputTokens: 1_000,
				outputTokens: 200,
				cachedInputTokens: 50,
				reasoningTokens: 25,
				totalTokens: 1_225,
			}),
		).toBe(0.00416);
		expect(
			estimateUsageCostUsd(null, {
				inputTokens: 1,
				outputTokens: 1,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 2,
			}),
		).toBeNull();
		expect(
			estimateUsageCostUsd("unknown-model", {
				inputTokens: 1,
				outputTokens: 1,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 2,
			}),
		).toBeNull();
	});

	it("counts token-consuming rows it cannot price", async () => {
		const { summarizeUsageRows } = await import("../lib/usage/index.js");

		const baseRow = {
			version: 1 as const,
			createdAt: 1_700_000_000_000,
			source: "runtime-proxy" as const,
			operation: "responses" as const,
			outcome: "success" as const,
			projectKey: undefined,
			account: undefined,
			requestId: undefined,
			statusCode: 200,
			errorCode: undefined,
			durationMs: 10,
		};
		const tokens = (total: number) => ({
			inputTokens: total,
			outputTokens: 0,
			cachedInputTokens: 0,
			reasoningTokens: 0,
			totalTokens: total,
		});

		const summary = summarizeUsageRows([
			// Priced: contributes real cost, not counted as unpriced.
			{ ...baseRow, id: "a", model: "gpt-5.3-codex", tokens: tokens(1000), costUsd: 0.00125 },
			// Unpriced but consumed tokens: cost is an under-count, so flag it.
			{ ...baseRow, id: "b", model: "gpt-5.5-pro", tokens: tokens(2000), costUsd: null },
			// Unpriced and consumed nothing (e.g. a blocked request): must NOT make
			// a cost budget unevaluable.
			{ ...baseRow, id: "c", model: "gpt-5.5-pro", tokens: tokens(0), costUsd: null },
		] as Parameters<typeof summarizeUsageRows>[0]);

		expect(summary.totals.unpricedRequests).toBe(1);
		expect(summary.totals.requests).toBe(3);
		expect(summary.totals.costUsd).toBe(0.00125);
	});

	it("retries transient append failures", async () => {
		const { appendUsageLedgerRow } = await import("../lib/usage/index.js");
		const realAppend = fs.appendFile.bind(fs);
		const appendSpy = vi.spyOn(fs, "appendFile");
		let attempts = 0;
		appendSpy.mockImplementation(async (...args) => {
			attempts += 1;
			if (attempts === 1) {
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return realAppend(...args);
		});

		try {
			await appendUsageLedgerRow({
				id: "retry",
				outcome: "success",
			});
			expect(attempts).toBe(2);
		} finally {
			appendSpy.mockRestore();
		}
	});

	it("removes stale append locks before writing", async () => {
		const {
			appendUsageLedgerRow,
			getUsageLedgerPaths,
			readUsageLedgerRows,
		} = await import("../lib/usage/index.js");
		const { dir, current } = getUsageLedgerPaths();
		const lockPath = `${current}.lock`;
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(lockPath, "stale\n", "utf8");
		const staleDate = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		await appendUsageLedgerRow({
			id: "after-stale-lock",
			outcome: "success",
		});

		await expect(fs.stat(lockPath)).rejects.toThrow();
		expect((await readUsageLedgerRows()).map((row) => row.id)).toEqual([
			"after-stale-lock",
		]);
	});
});


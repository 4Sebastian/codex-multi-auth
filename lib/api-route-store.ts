import { promises as fs, renameSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { tempPathFor } from "./temp-path.js";
import { withRetry } from "./fs-retry.js";
import { withStorageLock } from "./storage/transactions.js";
import { withFileTransactionLock } from "./storage/file-lock.js";
const API_ROUTE_SOURCE = Symbol("api-route-source");
const modelId = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const programId = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const accessPrograms = z.record(programId, z.array(programId).max(32))
	.refine(value => Object.keys(value).length <= 16);
const routeSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[A-Za-z0-9_-]+$/),
	label: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[^\x00-\x1f\x7f]+$/),
	kind: z.enum(["api", "zdr"]),
	apiKey: z.string().min(1).max(1024).regex(/^\S+$/),
	enabled: z.boolean(),
	priority: z.number().int().min(0).max(9),
	visibleModels: z.array(modelId).max(1000),
	knownModels: z.array(modelId).max(10000).optional(),
	probeCapabilities: z.boolean().optional(),
	/** Administrator-confirmed credential entitlements absent from API model discovery. */
	accessPrograms: accessPrograms.optional(),
	modelAccessPrograms: z.record(modelId, accessPrograms)
		.refine(value => Object.keys(value).length <= 1000).optional(),
});
const schema = z.object({
	version: z.literal(1),
	routes: z.array(routeSchema).max(100),
});
export type ApiRouteCredential = z.infer<typeof routeSchema> & {[API_ROUTE_SOURCE]?: {path: string; root: string}};
export function getApiRoutesPath(): string {
	return join(getCodexMultiAuthDir(), "api-routes.json");
}
function validate(value: unknown): ApiRouteCredential[] {
	const parsed = schema.safeParse(value);
	if (
		!parsed.success ||
		new Set(parsed.data.routes.map((r) => r.id)).size !==
			parsed.data.routes.length
	)
		throw new Error("Invalid API route configuration");
	return parsed.data.routes;
}
export async function loadApiRoutes(
	path = getApiRoutesPath(),
): Promise<ApiRouteCredential[]> {
	const source = {path, root: getApiRoutesPath()};
	let raw: string;
	try {
        raw = await withRetry(async () => {
		const handle = await fs.open(path, "r");
		try {
			const buffer = Buffer.alloc(1024 * 1024 + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 1024 * 1024)
				throw new Error("Invalid API route configuration");
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
        }, {maxAttempts:6,backoffMs:25});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error("Unable to read API route configuration");
	}
	try {
		return validate(JSON.parse(raw)).map(route => Object.defineProperty(route, API_ROUTE_SOURCE, {value: source}));
	} catch {
		throw new Error("Invalid API route configuration");
	}
}
export type ApiProbeAuthorization = () => Promise<() => boolean>;
export function captureApiProbeAuthorization(route: ApiRouteCredential): ApiProbeAuthorization {
	return captureApiRouteAuthorization(route, true);
}
export function captureApiRouteAuthorization(route: ApiRouteCredential, requireProbeConsent = false): ApiProbeAuthorization {
	const source = route[API_ROUTE_SOURCE]?.root ?? getApiRoutesPath();
	const path = route[API_ROUTE_SOURCE]?.path ?? source;
	const {id, kind, apiKey, enabled, probeCapabilities} = route;
	if (!enabled || requireProbeConsent && probeCapabilities !== true) return async () => () => false;
	let denied = false;
	const current = () => {
		if (denied) return false;
		try {
			const handle = openSync(path, "r");
			let routes: ApiRouteCredential[];
			try {
				const buffer = Buffer.alloc(1024 * 1024 + 1);
				const bytes = readSync(handle, buffer, 0, buffer.length, 0);
				if (bytes > 1024 * 1024) throw Error("Invalid API route configuration");
				routes = validate(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
			} finally {closeSync(handle);}
			const route = routes.find(candidate => candidate.id === id);
			denied = getApiRoutesPath() !== source || route?.enabled !== true || route.kind !== kind || route.apiKey !== apiKey ||
				(requireProbeConsent && route.probeCapabilities !== true);
		} catch {denied = true;}
		return !denied;
	};
	current();
	return async () => current;
}
export async function saveApiRoutes(
	routes: ApiRouteCredential[],
	path = getApiRoutesPath(),
	expected?: ApiRouteCredential[],
	authority?: () => boolean,
): Promise<void> {
	const validated = validate({ version: 1, routes });
	const serialized = JSON.stringify({ version: 1, routes: validated }) + "\n";
	if (Buffer.byteLength(serialized) > 1024 * 1024)
		throw new Error("API route configuration is too large");
	await withStorageLock(() => withFileTransactionLock(path, async () => {
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temp = tempPathFor(path);
		try {
			if (
				expected &&
				JSON.stringify(await loadApiRoutes(path)) !==
					JSON.stringify(validate({ version: 1, routes: expected }))
			) {
				throw new Error(
					"API route configuration changed; reopen the menu before saving.",
				);
			}
			await fs.writeFile(temp, serialized, { mode: 0o600, flag: "wx" });
			await withRetry(() => {
				if (!authority) return fs.rename(temp, path);
				if (!authority()) throw Error("API catalog authority changed");
				renameSync(temp, path);
				return Promise.resolve();
			}, {
				maxAttempts: 6,
				backoffMs: 25,
			});
		} finally {
			await withRetry(() => fs.unlink(temp), {
					maxAttempts: 6,
					backoffMs: 25,
				}).catch((error) => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				});
		}
	}));
}

/** Persist a discovery baseline and new GPT text IDs without undoing menu edits.
 * Callers supply IDs already filtered for the Responses endpoint family. */
let discoveryUpdates: Promise<void> = Promise.resolve();
export function updateApiModelDiscovery(
	route: ApiRouteCredential,
	models: string[],
	path = getApiRoutesPath(),
): Promise<ApiRouteCredential> {
	const source = route[API_ROUTE_SOURCE] ?? {path, root: getApiRoutesPath()};
	const authorize = source.path === path
		? captureApiRouteAuthorization(Object.defineProperty({...route}, API_ROUTE_SOURCE, {value: source}))
		: async () => () => false;
	const result = discoveryUpdates.then(() =>
		updateApiModelDiscoverySerial(route, models, path, authorize),
	);
	discoveryUpdates = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
async function updateApiModelDiscoverySerial(
	route: ApiRouteCredential,
	models: string[],
	path: string,
	authorize: ApiProbeAuthorization,
): Promise<ApiRouteCredential> {
	if (!(await authorize())()) throw Error("API catalog authority changed");
	const routes = await loadApiRoutes(path);
	const current = routes.find(
		(r) =>
			r.id === route.id && r.apiKey === route.apiKey && r.kind === route.kind,
	);
	if (!current) return { ...route, enabled: false, visibleModels: [] };
	if (!current.enabled) return current;
	const known = new Set(current.knownModels ?? models);
	const visible = new Set(current.visibleModels);
	for (const id of models) {
		if (!known.has(id) && /^gpt-/i.test(id)) visible.add(id);
		known.add(id);
	}
	const updated = {
		...current,
		knownModels: [...known],
		visibleModels: [...visible],
	};
	if (JSON.stringify(updated) !== JSON.stringify(current))
		await saveApiRoutes(
			routes.map((r) => (r.id === current.id ? updated : r)),
			path,
			routes,
			await authorize(),
		);
	return updated;
}

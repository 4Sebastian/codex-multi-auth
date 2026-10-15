import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withRetry } from "../lib/fs-retry.js";
import { getJsonStoreFileMtimeMs, writeJsonStoreFileAtomicWithRetry } from "../lib/storage/json-store-lock.js";
import { getBudgetGuardPath, loadBudgetGuardStore, saveBudgetGuardStore, upsertBudgetLimit } from "../lib/budget-guard.js";

let dir: string;
let target: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "json-atomic-"));
	target = join(dir, "store.json");
	await fs.writeFile(target, "{\"original\":true}\n", {mode: 0o600});
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await withRetry(() => fs.rm(dir, {recursive: true, force: true}), {maxAttempts: 6, backoffMs: 25});
});

it.each(["open", "write", "sync", "close", "cas", "rename"])("removes the real temp file and preserves the original target after %s failure", async stage => {
	const original = await fs.readFile(target, "utf8");
	const expectedMtimeMs = await getJsonStoreFileMtimeMs(target);
	const first = Object.assign(Error(`fixture ${stage}`), {code: stage === "write" ? "ENOSPC" : "EIO"});
	let temp: string | undefined;
	const open = fs.open.bind(fs);
	const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await open(...args);
		temp = String(args[0]);
		if (stage === "open") {await handle.close(); throw first;}
		if (stage === "write") vi.spyOn(handle, "writeFile").mockImplementation(async () => {await handle.write("partial private fixture"); throw first;});
		if (stage === "sync") vi.spyOn(handle, "sync").mockRejectedValue(first);
		if (stage === "close") {
			const close = handle.close.bind(handle);
			vi.spyOn(handle, "close").mockImplementation(async () => {await close(); throw first;});
		}
		return handle;
	});
	if (stage === "rename") vi.spyOn(fs, "rename").mockRejectedValue(first);
	const writing = writeJsonStoreFileAtomicWithRetry(target, {replacement: true}, {mode: 0o600, fsync: true, expectedMtimeMs: stage === "cas" ? expectedMtimeMs! - 1 : expectedMtimeMs});
	if (stage === "cas") await expect(writing).rejects.toMatchObject({code: "ESTALE"});
	else await expect(writing).rejects.toBe(first);
	expect(temp).toBeDefined();
	expect(opening).toHaveBeenCalledOnce();
	expect(await fs.readFile(target, "utf8")).toBe(original);
	expect(await fs.readdir(dir)).toEqual([basename(target)]);
});

it.each([false, true])("preserves the write failure even if close and cleanup also fail (unlink=%s)", async unlinkFails => {
	const original = await fs.readFile(target, "utf8");
	const first = Object.assign(Error("fixture partial write"), {code: "ENOSPC"});
	const second = Object.assign(Error("fixture close"), {code: "EIO"});
	const open = fs.open.bind(fs);
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await open(...args);
		vi.spyOn(handle, "writeFile").mockImplementation(async () => {await handle.write("partial"); throw first;});
		const close = handle.close.bind(handle);
		vi.spyOn(handle, "close").mockImplementation(async () => {await close(); throw second;});
		return handle;
	});
	const unlink = vi.spyOn(fs, "unlink");
	if (unlinkFails) unlink.mockRejectedValue(Error("fixture unlink"));
	await expect(writeJsonStoreFileAtomicWithRetry(target, {replacement: true}, {fsync: true})).rejects.toBe(first);
	expect(unlink).toHaveBeenCalledOnce();
	expect(await fs.readFile(target, "utf8")).toBe(original);
	expect(await fs.readdir(dir)).toHaveLength(unlinkFails ? 2 : 1);
});

it("preserves fsync, permissions and bounded transient rename retry on success", async () => {
	const expectedMtimeMs = await getJsonStoreFileMtimeMs(target);
	const open = fs.open.bind(fs);
	const synced = vi.fn();
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await open(...args);
		const sync = handle.sync.bind(handle);
		vi.spyOn(handle, "sync").mockImplementation(async () => {synced(); await sync();});
		return handle;
	});
	const rename = fs.rename.bind(fs);
	let attempts = 0;
	vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
		if (++attempts < 3) throw Object.assign(Error("fixture busy"), {code: "EBUSY"});
		return rename(...args);
	});
	await writeJsonStoreFileAtomicWithRetry(target, {replacement: true}, {mode: 0o600, fsync: true, expectedMtimeMs});
	expect(synced).toHaveBeenCalledOnce();
	expect(attempts).toBe(3);
	expect(await fs.readFile(target, "utf8")).toBe(`${JSON.stringify({replacement: true}, null, 2)}\n`);
	if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	expect(await fs.readdir(dir)).toEqual([basename(target)]);
});

it("retries terminal rename failure within the existing bound and leaves no temp file", async () => {
	const original = await fs.readFile(target, "utf8");
	const first = Object.assign(Error("fixture persistent busy"), {code: "EBUSY"});
	const rename = vi.spyOn(fs, "rename").mockRejectedValue(first);
	await expect(writeJsonStoreFileAtomicWithRetry(target, {})).rejects.toBe(first);
	expect(rename).toHaveBeenCalledTimes(5);
	expect(await fs.readFile(target, "utf8")).toBe(original);
	expect(await fs.readdir(dir)).toEqual([basename(target)]);
});

it("keeps a budget consumer unchanged after partial write failure and permits its next save", async () => {
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
	const store = await loadBudgetGuardStore();
	upsertBudgetLimit(store, {key: "fixture", window: "day", maxRequests: 1}, 1);
	await saveBudgetGuardStore(store);
	const path = getBudgetGuardPath();
	const original = await fs.readFile(path, "utf8");
	const updated = await loadBudgetGuardStore();
	upsertBudgetLimit(updated, {key: "fixture", window: "day", maxRequests: 2}, 2);
	const first = Object.assign(Error("fixture full disk"), {code: "ENOSPC"});
	const open = fs.open.bind(fs);
	const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await open(...args);
		vi.spyOn(handle, "writeFile").mockImplementation(async () => {await handle.write("partial private budget"); throw first;});
		return handle;
	});
	await expect(saveBudgetGuardStore(updated)).rejects.toBe(first);
	expect(await fs.readFile(path, "utf8")).toBe(original);
	expect((await loadBudgetGuardStore()).limits.fixture?.maxRequests).toBe(1);
	expect((await fs.readdir(dir)).sort()).toEqual([basename(path), basename(target)].sort());
	opening.mockRestore();
	await saveBudgetGuardStore(updated);
	expect((await loadBudgetGuardStore()).limits.fixture?.maxRequests).toBe(2);
	expect((await fs.readdir(dir)).sort()).toEqual([basename(path), basename(target)].sort());
});

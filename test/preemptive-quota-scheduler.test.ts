import { describe, expect, it } from "vitest";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
} from "../lib/preemptive-quota-scheduler.js";

describe("preemptive quota scheduler", () => {
	it("reads quota snapshot from codex headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "99",
			"x-codex-primary-reset-after-seconds": "120",
			"x-codex-secondary-used-percent": "10",
		});

		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 1_000);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.status).toBe(200);
		expect(snapshot?.primary.usedPercent).toBe(99);
		expect(snapshot?.primary.resetAtMs).toBeGreaterThan(1_000);
	});

	it("uses provided now when parsing reset-after seconds", () => {
		const headers = new Headers({
			"x-codex-primary-reset-after-seconds": "120",
		});
		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 5_000);
		expect(snapshot?.primary.resetAtMs).toBe(125_000);
	});

	it("returns null when quota headers are present but invalid", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "not-a-number",
			"x-codex-primary-reset-after-seconds": "oops",
			"x-codex-primary-reset-at": "not-a-date",
			"x-codex-secondary-reset-at": "still-not-a-date",
		});
		expect(readQuotaSchedulerSnapshot(headers, 200, 5_000)).toBeNull();
	});

	it("parses reset-at as epoch seconds, milliseconds, and HTTP date", () => {
		const secondsSnapshot = readQuotaSchedulerSnapshot(
			new Headers({
				"x-codex-primary-reset-at": "1700000000",
				"x-codex-secondary-reset-at": "1700000000000",
			}),
			200,
			0,
		);
		expect(secondsSnapshot?.primary.resetAtMs).toBe(1_700_000_000_000);
		expect(secondsSnapshot?.secondary.resetAtMs).toBe(1_700_000_000_000);

		const dateText = "Tue, 14 Nov 2023 22:13:20 GMT";
		const dateSnapshot = readQuotaSchedulerSnapshot(
			new Headers({
				"x-codex-primary-reset-at": dateText,
			}),
			200,
			0,
		);
		expect(dateSnapshot?.primary.resetAtMs).toBe(Date.parse(dateText));
	});

	it("defers requests for known 429 window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);

		const decision = scheduler.getDeferral("acc:model", 2_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBeGreaterThan(0);
	});

	it("preserves the longest known rate-limit reset across overlapping updates", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		scheduler.update("acc:model", {
			status: 429,
			primary: {},
			secondary: { resetAtMs: 31_000 },
			updatedAt: 1_000,
		});
		scheduler.markRateLimited("acc:model", 10_000, 5_000);

		const decision = scheduler.getDeferral("acc:model", 6_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBe(25_000);
	});

	it("uses the longest active reset window for 429 deferrals", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("acc:model", {
			status: 429,
			primary: { resetAtMs: 31_000 },
			secondary: { resetAtMs: 61_000 },
			updatedAt: 1_000,
		});

		const decision = scheduler.getDeferral("acc:model", 6_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBe(55_000);
	});

	it("preserves secondary near-exhaustion state when marking a quota key rate-limited", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdSecondary: 5,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 10, resetAtMs: 0 },
			secondary: { usedPercent: 97, resetAtMs: 61_000 },
			updatedAt: 1_000,
		});
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		const internalSnapshots = (
			scheduler as unknown as {
				snapshots: Map<string, { secondary: { usedPercent?: number; resetAtMs?: number } }>;
			}
		).snapshots;
		expect(internalSnapshots.get("acc:model")?.secondary.usedPercent).toBe(97);
		expect(internalSnapshots.get("acc:model")?.secondary.resetAtMs).toBe(61_000);
	});

	it("sanitizes non-finite retry-after values", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", Number.NaN, 1_000);
		const nanDecision = scheduler.getDeferral("acc:model", 1_000);
		expect(nanDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", Number.POSITIVE_INFINITY, 2_000);
		const infDecision = scheduler.getDeferral("acc:model", 2_000);
		expect(infDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", -1234, 3_000);
		const negativeDecision = scheduler.getDeferral("acc:model", 3_000);
		expect(negativeDecision.defer).toBe(false);
	});

	it("defers when usage is near exhaustion and reset is pending", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			usedPercentThreshold: 95,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: {
				usedPercent: 97,
				resetAtMs: 70_000,
			},
			secondary: {},
			updatedAt: 10_000,
		});

		const decision = scheduler.getDeferral("acc:model", 20_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("uses the longest near-exhausted reset window for quota deferrals", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdPrimary: 5,
			remainingPercentThresholdSecondary: 5,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 96, resetAtMs: 70_000 },
			secondary: { usedPercent: 97, resetAtMs: 120_000 },
			updatedAt: 10_000,
		});

		const decision = scheduler.getDeferral("acc:model", 20_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
		expect(decision.waitMs).toBe(100_000);
	});

	it("uses a trusted future reset for an exhausted long quota window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const resetWaitMs = 72 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 20, resetAtMs: now + 5 * 60 * 60_000 },
			secondary: { usedPercent: 100, resetAtMs: now + resetWaitMs },
			updatedAt: now,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision).toEqual({
			defer: true,
			waitMs: resetWaitMs - 1_000,
			reason: "quota-near-exhaustion",
		});
	});

	it("caps trusted monthly-scale reset data at the seven-day safety ceiling", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const sevenDaysMs = 7 * 24 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: {},
			secondary: {
				usedPercent: 100,
				resetAtMs: now + 30 * 24 * 60 * 60_000,
			},
			updatedAt: now,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision.waitMs).toBe(sevenDaysMs);
	});

	it.each([
		["missing", undefined],
		["invalid", Number.NaN],
	] as const)("falls back to the configured cap for %s reset data", (_label, resetAtMs) => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs },
			secondary: {},
			updatedAt: now,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision).toEqual({
			defer: true,
			waitMs: maxDeferralMs,
			reason: "quota-near-exhaustion",
		});
	});

	it("falls back to the configured cap for stale reset data", () => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		const sevenDaysMs = 7 * 24 * 60 * 60_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now + 72 * 60 * 60_000 },
			secondary: {},
			updatedAt: now - sevenDaysMs - 1,
		});

		const decision = scheduler.getDeferral("acc:model", now + 1_000);

		expect(decision).toEqual({
			defer: true,
			waitMs: maxDeferralMs,
			reason: "quota-near-exhaustion",
		});
	});

	it("falls back to the configured cap for a future-dated snapshot", () => {
		const maxDeferralMs = 30 * 60_000;
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now + 60 * 60_000 },
			secondary: {},
			updatedAt: now + 1,
		});

		expect(scheduler.getDeferral("acc:model", now)).toEqual({
			defer: true,
			waitMs: maxDeferralMs,
			reason: "quota-near-exhaustion",
		});
	});

	it("does not re-defer an exhausted window after its reset has passed", () => {
		const scheduler = new PreemptiveQuotaScheduler({ maxDeferralMs: 30 * 60_000 });
		const now = 1_000_000;
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 100, resetAtMs: now - 1_000 },
			secondary: { usedPercent: 20, resetAtMs: now + 7 * 24 * 60 * 60_000 },
			updatedAt: now - 500,
		});

		expect(scheduler.getDeferral("acc:model", now)).toEqual({
			defer: false,
			waitMs: 0,
		});
	});

	it("prunes expired snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("a", {
			status: 200,
			primary: { resetAtMs: 1_500 },
			secondary: {},
			updatedAt: 1_000,
		});
		scheduler.update("b", {
			status: 200,
			primary: { resetAtMs: 20_000 },
			secondary: {},
			updatedAt: 1_000,
		});

		const removed = scheduler.prune(2_000);
		expect(removed).toBe(1);
		expect(scheduler.getDeferral("a", 2_100).defer).toBe(false);
		expect(scheduler.getDeferral("b", 2_100).defer).toBe(false);
	});

	it("uses separate 5h/7d remaining thresholds", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdPrimary: 10,
			remainingPercentThresholdSecondary: 2,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 91, resetAtMs: 65_000 },
			secondary: { usedPercent: 97, resetAtMs: 66_000 },
			updatedAt: 1_000,
		});

		const decision = scheduler.getDeferral("acc:model", 5_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("can disable preemptive deferral without clearing snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);

		scheduler.configure({ enabled: false });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(false);

		scheduler.configure({ enabled: true });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);
	});

	it("ignores empty keys for update/markRateLimited and falls back when updatedAt is falsy", () => {
		const now = Date.now();
		const scheduler = new PreemptiveQuotaScheduler();

		scheduler.update("", {
			status: 200,
			primary: { usedPercent: 99, resetAtMs: now + 60_000 },
			secondary: {},
			updatedAt: now,
		});
		scheduler.markRateLimited("", 30_000, now);
		expect(scheduler.getDeferral("", now + 1_000)).toEqual({
			defer: false,
			waitMs: 0,
		});

		scheduler.update("acc:model", {
			status: 429,
			primary: { usedPercent: 100, resetAtMs: now + 45_000 },
			secondary: {},
			updatedAt: 0,
		});
		const decision = scheduler.getDeferral("acc:model", now + 5_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
	});

	it("prunes snapshots using the latest reset from primary or secondary windows", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("keep", {
			status: 200,
			primary: { resetAtMs: 1_000 },
			secondary: { resetAtMs: 7_000 },
			updatedAt: 0,
		});
		scheduler.update("drop", {
			status: 200,
			primary: { resetAtMs: 1_000 },
			secondary: { resetAtMs: 1_500 },
			updatedAt: 0,
		});

		const removed = scheduler.prune(2_000);
		expect(removed).toBe(1);
		expect(scheduler.prune(8_000)).toBe(1);
	});
	it("H4: a transient 429 does not bench the account on a benign weekly window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		const now = 1_000_000;
		const weekMs = 7 * 24 * 60 * 60 * 1000;
		// Healthy 200 snapshot: primary fine, weekly secondary resets ~7d out.
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 20, resetAtMs: now + 5 * 60_000 },
			secondary: { usedPercent: 30, resetAtMs: now + weekMs },
			updatedAt: now,
		});
		// Transient 60s 429.
		scheduler.markRateLimited("acc:model", 60_000, now);
		const decision = scheduler.getDeferral("acc:model", now + 1_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		// Must reflect the ~60s retry window, NOT the 7d weekly reset (which would
		// clamp to the 2h deferral cap). Allow the remaining ~59s.
		expect(decision.waitMs).toBeLessThanOrEqual(60_000);
		expect(decision.waitMs).toBeGreaterThan(50_000);
		// After the 429 window passes, the account is no longer rate-limit-deferred.
		const after = scheduler.getDeferral("acc:model", now + 61_000);
		expect(after.reason).not.toBe("rate-limit");
	});

});

it('clears only the recovered model quota without clearing sibling models',()=>{
 const scheduler=new PreemptiveQuotaScheduler();const now=Date.now();
 for(const key of ['account:model','account:model-other'])scheduler.update(key,{updatedAt:now,status:429,primary:{usedPercent:100,resetAtMs:now+60000},secondary:{}});
 scheduler.clear('account:model');
 expect(scheduler.getDeferral('account:model',now).defer).toBe(false);
 expect(scheduler.getDeferral('account:model-other',now).defer).toBe(true);
});

it.each(["primary", "secondary"] as const)("merges committed %s quota without carrying consumed fields", exhausted => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1_000_000;
	const other = exhausted === "primary" ? "secondary" : "primary";
	const partial = (window: "primary" | "secondary", usedPercent: number, planType?: string) => ({
		status: 200, updatedAt: now, primary: {}, secondary: {},
		[window]: {usedPercent, resetAtMs: now + 60000}, planType,
	});
	scheduler.observe("account:model", partial(exhausted, 100, "free"));
	const merged = scheduler.observe("account:model", partial(other, 20));
	expect(merged[exhausted].usedPercent).toBe(100);
	expect(merged[other].usedPercent).toBe(20);
	expect(merged.planType).toBe("free");
	expect(scheduler.getDeferral("account:model", now).defer).toBe(true);
	scheduler.observe("account:model", partial(exhausted, 0, "pro"));
	const healthy = scheduler.observe("account:model", {...partial(other, 20), planType: " "});
	expect(healthy[exhausted].usedPercent).toBe(0);
	expect(healthy.planType).toBe("pro");
	expect(scheduler.getDeferral("account:model", now).defer).toBe(false);
});

it("honors current scoped quota rather than another scheduler baseline", () => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1_000_000;
	scheduler.update("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 100}, secondary: {}, planType: "free"});
	const scoped = scheduler.observe("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {usedPercent: 20}}, {
		primary: {usedPercent: 0}, secondary: {}, planType: "pro",
	});
	expect(scoped).toMatchObject({primary: {usedPercent: 0}, secondary: {usedPercent: 20}, planType: "pro"});
	expect(scheduler.getDeferral("account:model", now).defer).toBe(false);
	scheduler.update("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {usedPercent: 100}});
	const absent = scheduler.observe("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 20}, secondary: {}}, null);
	expect(absent.secondary).toEqual({});
	expect(scheduler.getDeferral("account:model", now).defer).toBe(false);
});

it.each(["clear", "clearAll", "clearByPrefix", "full-replacement", "prune"])("does not revive consumed quota after %s", action => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1_000_000;
	scheduler.observe("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {usedPercent: 100, resetAtMs: now + 1000}, planType: "free"});
	if (action === "clear") scheduler.clear("account:model");
	if (action === "clearAll") scheduler.clearAll();
	if (action === "clearByPrefix") scheduler.clearByPrefix("account:");
	if (action === "full-replacement") scheduler.update("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {}});
	const later = action === "prune" ? now + 60001 : now;
	const merged = scheduler.observe("account:model", {status: 200, updatedAt: later, primary: {usedPercent: 20}, secondary: {}});
	expect(merged.secondary).toEqual({});
	expect(merged.planType).toBeUndefined();
	expect(scheduler.getDeferral("account:model", later).defer).toBe(false);
});

it("retains a rate-limit window during unrelated partial observations", () => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1_000_000;
	scheduler.markRateLimited("account:model", 60000, now);
	const merged = scheduler.observe("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {usedPercent: 20}});
	expect(merged.primary).toEqual({usedPercent: 100, resetAtMs: now + 60000});
	expect(scheduler.getDeferral("account:model", now).defer).toBe(true);
});

it.each(["primary", "secondary"] as const)("rejects older %s receipts while retaining independent fields", window => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1000000;
	const other = window === "primary" ? "secondary" : "primary";
	const older = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {}, [window]: {usedPercent: 20}, [other]: {usedPercent: 10}, planType: "free"}, "A");
	const newer = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {}, [window]: {usedPercent: 100, resetAtMs: now + 60000}, planType: "pro"}, "A");
	scheduler.observeReceipt("account:model", newer); scheduler.settleReceipt("account:model", newer, true);
	const merged = scheduler.observeReceipt("account:model", older);
	scheduler.settleReceipt("account:model", older, true);
	expect(merged?.[window]).toEqual({usedPercent: 100, resetAtMs: now + 60000});
	expect(merged?.[other]).toEqual({usedPercent: 10});
	expect(merged?.planType).toBe("pro");
	expect(scheduler.getDeferral("account:model", now, "A").defer).toBe(true);
});

it("keeps failed exhaustion credential-scoped until a valid replacement settles", () => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1000000;
	const failed = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 100, resetAtMs: now + 60000}, secondary: {}}, "A");
	scheduler.settleReceipt("account:model", failed, false);
	expect(scheduler.getDeferral("account:model", now, "A").defer).toBe(true);
	expect(scheduler.getDeferral("account:model", now, "B").defer).toBe(false);
	const healthy = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 0}, secondary: {}}, "A");
	expect(scheduler.getDeferral("account:model", now, "A").defer).toBe(true);
	scheduler.observeReceipt("account:model", healthy); scheduler.settleReceipt("account:model", healthy, true);
	scheduler.settleReceipt("account:model", failed, false);
	expect(scheduler.getDeferral("account:model", now, "A").defer).toBe(false);
	const other = scheduler.receive("other:model", failed.snapshot, "A");
	scheduler.settleReceipt("other:model", other, false);
	expect(scheduler.getDeferral("other:model", now, "A").defer).toBe(true);
});

it("does not attribute retired receipts or failures to a recovered owner", () => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1000000;
	const a = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 100}, secondary: {}}, "A");
	const b = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 0}, secondary: {}, planType: "pro"}, "B");
	expect(scheduler.observeReceipt("account:model", a)).toBeUndefined();
	scheduler.settleReceipt("account:model", a, false);
	scheduler.observeReceipt("account:model", b); scheduler.settleReceipt("account:model", b, true);
	expect(scheduler.getDeferral("account:model", now, "B").defer).toBe(false);
});

it("retains failed exhaustion when the earlier healthy snapshot expires", () => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1000000;
	scheduler.update("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 20, resetAtMs: now + 1000}, secondary: {}});
	const failed = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 100, resetAtMs: now + 60000}, secondary: {}}, "A");
	scheduler.settleReceipt("account:model", failed, false);
	expect(scheduler.prune(now + 2000)).toBe(0);
	expect(scheduler.getDeferral("account:model", now + 2000, "A").defer).toBe(true);
	expect(scheduler.prune(now + 60001)).toBe(1);
	expect(scheduler.getDeferral("account:model", now + 60001, "A").defer).toBe(false);
});

it.each(["clear", "full-replacement", "rate-limit", "prune"])("retires queued receipts on %s", action => {
	const scheduler = new PreemptiveQuotaScheduler(), now = 1000000;
	scheduler.update("account:model", {status: 200, updatedAt: now, primary: {}, secondary: {usedPercent: 20, resetAtMs: now + 1000}});
	const old = scheduler.receive("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 100}, secondary: {}}, "A");
	if (action === "clear") scheduler.clear("account:model");
	if (action === "full-replacement") scheduler.update("account:model", {status: 200, updatedAt: now, primary: {usedPercent: 0}, secondary: {}});
	if (action === "rate-limit") scheduler.markRateLimited("account:model", 60000, now);
	if (action === "prune") scheduler.prune(now + 2000);
	expect(scheduler.observeReceipt("account:model", old)).toBeUndefined();
	expect(scheduler.getDeferral("account:model", now, "A").defer).toBe(action === "rate-limit");
});

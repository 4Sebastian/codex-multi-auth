import type { AccountManager, CurrentAccountCredential, ManagedAccount } from "../accounts.js";
import { getCircuitBreaker, type CircuitAdmissionReceipt } from "../circuit-breaker.js";
import type { ModelFamily } from "../prompts/codex.js";
import { logWarn } from "../logger.js";
import { captureRuntimePolicyRevision, evaluateRuntimePolicy, loadRuntimePolicyState } from "../policy/runtime-policy.js";
import { captureAuthorityRevision } from "../storage/authority-revision.js";
import { getIntentionalResetMarkerPath } from "../storage/backup-paths.js";
import { PendingAuthAdmissionError, PendingAuthLocalError } from "../storage/pending-auth.js";

export function createAccountDispatch(params: {
	manager: AccountManager;
	account: ManagedAccount;
	submitted: CurrentAccountCredential;
	admission: CircuitAdmissionReceipt;
	family: ModelFamily;
	model: string | null;
	eligible: () => boolean;
}): (send: () => Promise<Response>) => Promise<Response> {
	const {manager, account, submitted, admission, family, model} = params;
	const path = manager.resolveSelectionStoragePath();
	const resetCurrent = captureAuthorityRevision([], [getIntentionalResetMarkerPath(path)]);
	return async send => {
		let enteredSend = false;
		let dispatched: Promise<Response> | undefined;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const policyCurrent = captureRuntimePolicyRevision();
				const state = await loadRuntimePolicyState();
				// Policy indexes belong to this snapshot, not the live pool after a wait.
				const policyIndex = account.index;
				const policy = await evaluateRuntimePolicy({state, accounts: manager.getAccountsSnapshot(), model, now: Date.now()});
				let changed = false;
				await manager.withCurrentAccountCredential(account, submitted, row => {
					changed = !policyCurrent(policy.budgetEvaluations.length > 0);
					if (changed || !resetCurrent() || manager.resolveSelectionStoragePath() !== path || !policy.allowed || policy.blockedAccountIndexes.has(policyIndex) ||
						(submitted.expiresAt ?? 0) <= Date.now() || !account.circuitKeyId || !getCircuitBreaker(account.circuitKeyId).isAdmissionCurrent(admission) || !params.eligible()) return false;
					const reason = manager.getManagedAccountRuntimeSkipReason(account, family, model);
					if (reason && !(reason === "circuit-open" && admission.halfOpen)) return false;
					if (row && ((row.coolingDownUntil ?? 0) > Date.now() ||
						(row.rateLimitResetTimes?.[family] ?? 0) > Date.now() ||
						(model && (row.rateLimitResetTimes?.[`${family}:${model}`] ?? 0) > Date.now()))) return false;
					enteredSend = true;
					dispatched = send();
					void dispatched.catch(() => undefined);
					return true;
				}, false);
				if (dispatched) return dispatched;
				if (!changed || attempt === 1) break;
			}
		} catch (error) {
			if (dispatched) {
				logWarn("Submitted dispatch cleanup authority could not be observed", {error});
				return dispatched;
			}
			if (enteredSend || error instanceof PendingAuthLocalError) throw error;
			throw new PendingAuthAdmissionError(error);
		}
		throw new PendingAuthAdmissionError(Object.assign(new Error("Request-bound dispatch is no longer authorized"), {code: "ESTALE"}));
	};
}

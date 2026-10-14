import { join } from 'node:path';
import { AccountManager, extractAccountId, resolveAccountRecordId, sanitizeEmail } from '../accounts.js';
import { loadAccounts, type AccountMetadataV3 } from '../storage.js';
import { getCodexMultiAuthDir } from '../runtime-paths.js';
import { ensureFreshAccessToken } from './rotation-token-refresh.js';
import { modelScopeId } from './workspace-model-scopes.js';
import { nativeRateLimitsRpc, type NativeUsageAuth } from './native-rate-limits.js';
import { captureRefreshCredentialAuthority, PendingAuthAdmissionError } from '../storage/pending-auth.js';
import type { TokenSuccess } from '../types.js';
import { codexCliAccountIdFor } from '../auth/token-utils.js';
import { isRecord } from '../utils.js';
import { ResetCreditService, resetCredentialOwner, type ResetTarget } from './reset-credits.js';
import { withCheckProgress } from '../ui/check-progress.js';

export function resetTargetForStoredAccount(account:AccountMetadataV3):ResetTarget|null{
 // Organization display aliases are not native ChatGPT workspace identities.
 const stored=account.accountId?.trim();
 const id=stored?.startsWith("org-") ? extractAccountId(account.accessToken)?.trim() : stored;
 const workspace=account.workspaces?.find(w=>w.id===id);
 if(!id||id.startsWith("org-")||account.enabled===false||workspace?.enabled===false)return null;
 return {key:modelScopeId('oauth',resolveAccountRecordId(account),id),accountId:id};
}
export function isResetTargetEnabled(account:AccountMetadataV3,target:ResetTarget):boolean {
 if(account.enabled===false)return false;
 const canonical=resetTargetForStoredAccount(account);
 if(canonical?.key===target.key&&canonical.accountId===target.accountId)return true;
 const scopeKey=modelScopeId('oauth',resolveAccountRecordId(account),target.accountId);
 return !target.accountId.startsWith('org-')&&scopeKey===target.key&&Boolean(account.workspaces?.some(w=>w.id===target.accountId&&w.enabled!==false));
}

export function createResetCreditService(manager?:AccountManager):ResetCreditService {
 return new ResetCreditService(join(getCodexMultiAuthDir(),'reset-credits.json'),{bind:target=>{
  const matches=manager?.getAccountsSnapshot().filter(a=>isResetTargetEnabled({...a,accessToken:a.access},target));
  if(matches&&matches.length>1)throw Error('Reset account identity is ambiguous; repair duplicate records before checking or redeeming');
  const account=matches?.[0];
  const current=account&&manager?.getAccountByIndex(account.index);
  if(!manager||!current||current.enabled===false)throw Error('Reset workspace is not enabled');
  const path=manager.resolveSelectionStoragePath();
  const recordId=current.recordId;
  const mirror=structuredClone(current.codexCliMirror);
  const sourceCurrent=captureRefreshCredentialAuthority(current,()=>manager.resolveSelectionStoragePath()===path&&manager.getAccountByIndex(current.index)===current&&current.recordId===recordId);
  let result:TokenSuccess|undefined;
  let readyForUse=false;
  let submitted={recordId,accessToken:current.access,refreshToken:current.refreshToken,expiresAt:current.expires,accountId:target.accountId};
  const denied=()=>new PendingAuthAdmissionError(Object.assign(Error('Reset account authority changed'),{code:'ESTALE'}));
  const authorize=async(accept:()=>void)=>{
   const valid=await manager.withCurrentAccountCredential(current,submitted,()=>{
    if((readyForUse&&(submitted.expiresAt??0)<=Date.now()+30000)||!sourceCurrent(result)||current.enabled===false||manager.isAccountAuthInvalidated(current)||!isResetTargetEnabled({...current,accessToken:current.access},target)||JSON.stringify(current.codexCliMirror)!==JSON.stringify(mirror))return false;
    accept();return true;
   },false);
   if(!valid)throw denied();
  };
  let preparation:Promise<NativeUsageAuth>|undefined;
  const auth=()=>preparation??=(async()=>{
   await authorize(()=>{});
   const fresh=await ensureFreshAccessToken({accountManager:manager,account:current,family:'codex',model:null,now:Date.now(),tokenRefreshSkewMs:60000,tokenInvalidationCooldownMs:300000,
    authorityCurrent:owned=>{const valid=sourceCurrent(owned);if(valid&&owned)result=owned;return valid;}});
   if(!fresh.ok||fresh.account!==current)throw denied();
   submitted={recordId,accessToken:fresh.accessToken,refreshToken:current.refreshToken,expiresAt:current.expires,accountId:target.accountId};
   readyForUse=true;
   await authorize(()=>{});
   return {accessToken:fresh.accessToken,accountId:target.accountId,expiresAt:current.expires??0,codexCliMirror:mirror,withAuthority:authorize};
  })();
  return {
   get credentialOwner(){return resetCredentialOwner({recordId:submitted.recordId,access:submitted.accessToken,refreshToken:submitted.refreshToken,expires:submitted.expiresAt},target.accountId);},
   authorize:async accept=>{await auth();await authorize(accept);},
   read:async()=>{
    const freshAuth=await auth();
    const sent=codexCliAccountIdFor(freshAuth,freshAuth.accessToken)??freshAuth.accountId;
    const reply=await nativeRateLimitsRpc(freshAuth,'account/rateLimits/read',{excludeResetCreditDetails:true});
    await authorize(()=>{});
    if(!isRecord(reply)||reply.accountId!==sent)throw Error('Reset credit workspace identity mismatch');
    return {...reply,accountId:target.accountId};
   },
   consume:async idempotencyKey=>{
    const freshAuth=await auth();
    const reply=await nativeRateLimitsRpc(freshAuth,'account/rateLimitResetCredit/consume',{idempotencyKey});
    await authorize(()=>{});
    return reply;
   },
  };
 }});
}
export async function loadResetCreditState(){return createResetCreditService().status();}
/** Local terminal labels only; never used in provider requests or public artifacts. */
export function resetAccountLabel(account: Pick<AccountMetadataV3, "email">, index: number): string {
 const email = sanitizeEmail(account.email);
 const printable = email && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(email);
 return `Account ${index + 1}${printable ? ` (${email})` : ""}`;
}
export async function refreshAndPrintResetCredits(log:(message:string)=>void){
 const storage=await loadAccounts();if(!storage?.accounts.length)return;
 const manager=new AccountManager(undefined,storage);
 const targets=storage.accounts.map(resetTargetForStoredAccount).filter((t):t is ResetTarget=>Boolean(t));
 try{
  const snapshots=await withCheckProgress(`Checking reset credits for ${targets.length} accounts`,()=>createResetCreditService(manager).refresh(targets),log);
  storage.accounts.forEach((a,i)=>{const target=resetTargetForStoredAccount(a);const count=target?snapshots[target.key]?.availableCount:undefined;log(`${resetAccountLabel(a,i)}: available subscription resets: ${count??'unknown (not verified)'}`);});
 }finally{await manager.flushPendingSave();}
}

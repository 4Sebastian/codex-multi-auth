import { withRetry } from "../fs-retry.js";
import { resolve } from "node:path";
import { randomUUID } from 'node:crypto';
import { promises as fs, renameSync } from 'node:fs';
import type { ManagedAccount } from '../accounts.js';
import { modelScopeId } from './workspace-model-scopes.js';
import { z } from 'zod';
import { withFileTransactionLock } from '../storage/file-lock.js';
import { mapWithConcurrency } from '../concurrency.js';
import type { QuotaCacheEntry } from '../quota-cache.js';
import { MAX_RATE_LIMIT_DELAY_MS } from '../constants.js';

export interface ResetTarget { key: string; accountId: string }
const windowSchema=z.object({usedPercent:z.number().min(0).max(100).optional(),resetsAt:z.number().nonnegative().nullish(),windowDurationMins:z.number().nonnegative().nullish()});
const snapshotSchema=z.object({credentialOwner:z.string().optional(),updatedAt:z.number(),availableCount:z.number().int().nonnegative().nullable(),ordinaryUsageAllowed:z.boolean().nullable(),planType:z.string().nullable(),primary:windowSchema,secondary:windowSchema});
const RESET_PUBLICATION=Symbol('reset-publication');
export type ResetSnapshot=z.infer<typeof snapshotSchema> & {[RESET_PUBLICATION]?:()=>void};
const stateSchema=z.object({version:z.literal(1),policy:z.enum(['manual','last-resort']).default('manual'),snapshots:z.record(z.string(),snapshotSchema).default({}),pending:z.object({key:z.string(),idempotencyKey:z.string().uuid(),credentialOwner:z.string().optional()}).optional(),lastAutomaticCheckAt:z.number().optional(),lastRedemptionAt:z.number().optional(),lastRedemption:z.object({key:z.string(),at:z.number(),outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed']),automatic:z.boolean()}).optional()});
type State=Omit<z.infer<typeof stateSchema>,'snapshots'> & {snapshots:Record<string,ResetSnapshot>};
const readSchema=z.object({accountId:z.string(),ordinaryUsageAllowed:z.boolean().nullish(),rateLimitResetCredits:z.object({availableCount:z.number().int().nonnegative()}).nullish(),rateLimits:z.object({planType:z.string().nullish(),primary:windowSchema.nullish(),secondary:windowSchema.nullish()})});
const outcomeSchema=z.object({outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed'])});
export type ResetOutcome=z.infer<typeof outcomeSchema>['outcome'];
export function parseResetSnapshot(value:unknown,accountId:string,now:number):ResetSnapshot {
 const parsed=readSchema.parse(value);
 if(parsed.accountId!==accountId)throw Error('Reset credit workspace identity mismatch');
 return {updatedAt:now,availableCount:parsed.rateLimitResetCredits?.availableCount??null,ordinaryUsageAllowed:parsed.ordinaryUsageAllowed??null,planType:parsed.rateLimits.planType??null,primary:parsed.rateLimits.primary??{},secondary:parsed.rateLimits.secondary??{}};
}
export function resetSnapshotQuota(snapshot:ResetSnapshot):QuotaCacheEntry {
 // A bogus resetsAt must not read as a window that never resets.
 const resetAtMs=(s:number|null|undefined)=>typeof s==='number'&&Number.isFinite(s)?Math.min(s*1000,snapshot.updatedAt+MAX_RATE_LIMIT_DELAY_MS):undefined;
 const window=(w:ResetSnapshot['primary'])=>({usedPercent:w.usedPercent,resetAtMs:resetAtMs(w.resetsAt),windowMinutes:w.windowDurationMins??undefined});
 return {updatedAt:snapshot.updatedAt,status:200,model:'usage-read',planType:snapshot.planType??undefined,primary:window(snapshot.primary),secondary:window(snapshot.secondary)};
}
export function isResetSubscription(snapshot:ResetSnapshot):boolean {
 return ['plus','pro','prolite','team','business','self_serve_business_prolite','enterprise','edu','edu_plus','edu_pro'].includes(snapshot.planType??'');
}
export function resetCredentialOwner(account:Pick<ManagedAccount,'recordId'|'access'|'refreshToken'|'expires'>,workspaceId:string):string {
 return modelScopeId('reset',account.recordId??'',workspaceId,account.access??'',account.refreshToken,String(account.expires));
}
export interface ResetCreditBinding {
 read:()=>Promise<{value:unknown;publish?:()=>void}>;
 consume:(idempotencyKey:string)=>Promise<unknown>;
 authorize:(accept:()=>void)=>Promise<void>;
 credentialOwner?:string;
}
export type ResetCreditIO = {now?:()=>number} & ({
 read:(target:ResetTarget)=>Promise<unknown>;
 consume:(target:ResetTarget,idempotencyKey:string)=>Promise<unknown>;
} | {bind:(target:ResetTarget)=>ResetCreditBinding});
/** No credentials or credit IDs are persisted. One global redemption lease covers
 * all accounts: concurrent exhausted requests cannot independently spend credits. */
/** A stored time further ahead than this came from a clock that has since stepped back: treat it as expired. */
const FUTURE_SKEW_MS=5*60000;
const within=(at:number|undefined,now:number,windowMs:number)=>at!==undefined&&at<=now+FUTURE_SKEW_MS&&now-at<windowMs;
const automaticChecks = new Map<string, {targets:string; promise:Promise<{key:string;outcome:ResetOutcome}|null>}>();
export class ResetCreditService {
 constructor(private readonly path:string,private readonly io:ResetCreditIO){}
 private now(){return this.io.now?.()??Date.now();}
 private bind(target:ResetTarget):ResetCreditBinding {
  const io=this.io;
  return 'bind' in io?io.bind(target):{read:async()=>({value:await io.read(target)}),consume:key=>io.consume(target,key),authorize:accept=>Promise.resolve().then(accept)};
 }
 async status():Promise<State>{
  try { const stat=await fs.lstat(this.path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid reset-credit state file');return stateSchema.parse(JSON.parse(await fs.readFile(this.path,'utf8'))); }
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,policy:'manual',snapshots:{}};throw e;}
 }
 private async save(state:State,authorize:ResetCreditBinding['authorize']=accept=>Promise.resolve().then(accept)){
  const path=this.path+'.'+randomUUID()+'.tmp';
  try {
   const file=await fs.open(path,'wx',0o600);
   try {await file.writeFile(JSON.stringify(stateSchema.parse(state))+'\n');await file.sync();} finally {await file.close();}
   await withRetry(()=>'bind' in this.io?authorize(()=>{
    renameSync(path,this.path);
    for(const snapshot of Object.values(state.snapshots)){const publish=snapshot[RESET_PUBLICATION];delete snapshot[RESET_PUBLICATION];publish?.();}
   }):fs.rename(path,this.path),{maxAttempts:6,backoffMs:25});
  }
  finally {await fs.rm(path,{force:true});}
 }
 async setPolicy(policy:State['policy']){await withFileTransactionLock(this.path,async()=>{const s=await this.status();s.policy=policy;await this.save(s);});}
 private async read(target:ResetTarget,binding:ResetCreditBinding):Promise<ResetSnapshot>{const read=await binding.read();return {...parseResetSnapshot(read.value,target.accountId,this.now()),...(binding.credentialOwner?{credentialOwner:binding.credentialOwner}:{}),[RESET_PUBLICATION]:read.publish};}
 async refresh(targets:ResetTarget[]):Promise<Record<string,ResetSnapshot>>{
  const bindings=targets.map(target=>{try{return {target,binding:this.bind(target)}}catch{return null}});
  const results=await mapWithConcurrency(bindings,3,async item=>{try{return item&&{...item,snapshot:await this.read(item.target,item.binding)}}catch{return null}});
  const updated:Record<string,ResetSnapshot>={};
  for(const row of results)if(row){
   try{await withFileTransactionLock(this.path,async()=>{
    const state=await this.status();const old=state.snapshots[row.target.key];
    if(!old||old.updatedAt<=row.snapshot.updatedAt||old.updatedAt>this.now()+FUTURE_SKEW_MS)state.snapshots[row.target.key]=row.snapshot;
    await this.save(state,row.binding.authorize);updated[row.target.key]=row.snapshot;
   });}catch{}
  }
  return updated;
 }
 private async consumeLocked(state:State,target:ResetTarget,binding:ResetCreditBinding,automatic=false):Promise<ResetOutcome>{
  await binding.authorize(()=>{});
  if(state.pending&&(state.pending.key!==target.key||state.pending.credentialOwner!==binding.credentialOwner))throw Error('A reset redemption is pending for another account or credential; its original outcome must be reconciled first.');
  state.pending??={key:target.key,idempotencyKey:randomUUID(),...(binding.credentialOwner?{credentialOwner:binding.credentialOwner}:{})};
  state.lastRedemptionAt=this.now();await this.save(state,binding.authorize);
  const result=outcomeSchema.parse(await binding.consume(state.pending.idempotencyKey));
  // Keep the same key on *any* ambiguous outcome, including a failed follow-up read.
  state.snapshots[target.key]=await this.read(target,binding);
  state.lastRedemption={key:target.key,at:this.now(),outcome:result.outcome,automatic};
  delete state.pending;await this.save(state,binding.authorize);return result.outcome;
 }
 async redeem(target:ResetTarget):Promise<ResetOutcome>{
  const binding=this.bind(target);
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   if(!state.pending&&within(state.lastRedemptionAt,this.now(),10000))throw Error('A reset was just redeemed; refresh usage before trying again.');
   if(!state.pending){const snapshot=await this.read(target,binding);state.snapshots[target.key]=snapshot;await this.save(state,binding.authorize);if(snapshot.availableCount===null)throw Error('Reset-credit availability is unknown');if(snapshot.availableCount===0)return 'noCredit';}
   return this.consumeLocked(state,target,binding);
  });
 }
 automatic(targets:ResetTarget[]):Promise<{key:string;outcome:ResetOutcome}|null>{
  const key=resolve(this.path), signature=JSON.stringify(targets), pending=automaticChecks.get(key);
  if(pending)return pending.targets===signature?pending.promise:pending.promise.then(()=>null);
  if(automaticChecks.size>=1000)return Promise.resolve(null);
  const promise=this.automaticLocked(targets).finally(()=>{automaticChecks.delete(key);});
  automaticChecks.set(key,{targets:signature,promise});
  return promise;
 }
 private async automaticLocked(targets:ResetTarget[]):Promise<{key:string;outcome:ResetOutcome}|null>{
  const bindings=targets.map(target=>{try{return this.bind(target)}catch{return null}});
  if(bindings.some(binding=>!binding))return null;
  if(!targets.length||(await this.status()).policy!=='last-resort')return null;
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   if(state.policy!=='last-resort'||state.pending||within(state.lastAutomaticCheckAt,this.now(),60000)||within(state.lastRedemptionAt,this.now(),300000))return null;
   state.lastAutomaticCheckAt=this.now();await this.save(state);
   // Missing/failed reads prevent spending. A scheduled reset that has arrived
   // is confirmed by ordinaryUsageAllowed, never inferred from a clock or %.
   const reads=await mapWithConcurrency(targets,3,async (t,i)=>{const binding=bindings[i];try{return binding?await this.read(t,binding):null}catch{return null}});
   for(let i=0;i<reads.length;i++){
    const snapshot=reads[i],target=targets[i],binding=bindings[i];
    if(!snapshot||!target||!binding)continue;
    state.snapshots[target.key]=snapshot;
    try{await this.save(state,binding.authorize);}catch{reads[i]=null;delete state.snapshots[target.key];}
   }
   if(reads.some(s=>!s||!isResetSubscription(s)||s.ordinaryUsageAllowed!==false))return null;
   if(reads.some(s=>s&&[s.primary,s.secondary].some(w=>w.usedPercent===100&&typeof w.resetsAt==='number'&&w.resetsAt*1000<=this.now()+60000)))return null;
   const index=reads.findIndex(s=>s!==null&&(s.availableCount??0)>0);const target=targets[index];
   const binding=bindings[index];
   if(!target||!binding)return null;
   for(const candidate of bindings){if(!candidate)return null;await candidate.authorize(()=>{});}
   return {key:target.key,outcome:await this.consumeLocked(state,target,binding,true)};
  },{waitMs:1000});
 }
}

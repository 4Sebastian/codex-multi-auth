import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreemptiveQuotaScheduler } from '../lib/preemptive-quota-scheduler.js';
import { loadQuotaCache,saveQuotaCache,type QuotaCacheEntry } from '../lib/quota-cache.js';
import { AccountManager } from '../lib/accounts.js';
import { getStoragePath, setStoragePath, withAccountStorageTransaction, type AccountStorageV3 } from '../lib/storage.js';
import { getPendingAuthPath } from '../lib/storage/pending-auth.js';
import { createResetCreditService, resetTargetForStoredAccount } from '../lib/runtime/account-reset-credits.js';
import { applyConfirmedReset, recoverResetQuota } from '../lib/runtime/reset-credit-routing.js';
import {resetSnapshotQuota} from '../lib/runtime/reset-credits.js';
import { resetCredentialOwner } from '../lib/runtime/reset-credits.js';
import { workspaceModelScopes } from '../lib/runtime/workspace-model-scopes.js';
import * as native from '../lib/runtime/native-rate-limits.js';
import { withFileTransactionLock } from '../lib/storage/file-lock.js';
import { removeWithRetry } from './helpers/remove-with-retry.js';
import { writeAccountSourceFixture } from './helpers/account-source-fixture.js';

let dir:string;
let managers:AccountManager[]=[];
beforeEach(async()=>{
 dir=await mkdtemp(join(tmpdir(),'reset-authority-'));
 vi.stubEnv('CODEX_MULTI_AUTH_DIR',dir);
 setStoragePath(null);
});
afterEach(async()=>{
 for(const manager of managers)await manager.flushPendingSave();
 managers=[];vi.restoreAllMocks();vi.unstubAllEnvs();setStoragePath(null);
 await removeWithRetry(dir,{recursive:true,force:true});
});
function fixture(){
 const storage:AccountStorageV3={version:3,activeIndex:0,accounts:[{recordId:'owned',accountId:'workspace',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,enabled:true,addedAt:1,lastUsed:1,workspaces:[{id:'workspace',enabled:true},{id:'sibling',enabled:true}]}]};
 writeAccountSourceFixture(storage);
 const manager=new AccountManager(undefined,storage);managers.push(manager);
 const account=manager.getAccountByIndex(0)!;
 const target=resetTargetForStoredAccount(storage.accounts[0]!)!;
 const service=createResetCreditService(manager);
 return {storage,manager,account,target,service,path:getStoragePath()};
}
async function backend(holdInitialize=0,holdResponse=0){
 const script=join(dir,'backend.mjs');
 await writeFile(script,`import {createInterface} from 'node:readline';import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
 const root=${JSON.stringify(dir)}, log=root+'/operations.jsonl';
 const wait=async(path)=>{while(!existsSync(path))await new Promise(resolve=>setTimeout(resolve,5));};
 const reply=(id,result)=>console.log(JSON.stringify({id,result}));
 createInterface({input:process.stdin}).on('line',async line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='initialize'){
   appendFileSync(root+'/sessions','init\\n');
   const session=readFileSync(root+'/sessions','utf8').trim().split('\\n').length;
   writeFileSync(root+'/initialized-'+session,String(process.pid));
   if(session===${holdInitialize})await wait(root+'/release-init');
   reply(m.id,{});return;
  }
  appendFileSync(log,JSON.stringify(m)+'\\n');
  const count=readFileSync(log,'utf8').trim().split('\\n').length;
  writeFileSync(root+'/received-'+count,'ready');
  if(count===${holdResponse})await wait(root+'/release-response');
  const accountId=JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json','utf8')).tokens.account_id;
  reply(m.id,m.method.endsWith('/consume')?{outcome:'reset'}:{accountId,ordinaryUsageAllowed:true,rateLimitResetCredits:{availableCount:2},rateLimits:{planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}});
 });`);
 const real=native.nativeRateLimitsRpc;
 vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation((auth,method,params)=>real(auth,method,params,{command:[process.execPath,script],tempRoot:dir,timeoutMs:10000}));
}
async function ready(name:string){await vi.waitFor(()=>expect(existsSync(join(dir,name))).toBe(true),{timeout:10000,interval:10});}
function operations():{method:string;params:{idempotencyKey?:string}}[]{
 try{return readFileSync(join(dir,'operations.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}
}
async function cleanBackend(){await vi.waitFor(async()=>expect((await readdir(dir)).filter(name=>name.startsWith('reset-rpc-'))).toEqual([]),{timeout:10000,interval:10});}
it.each(['apply','recover'].flatMap(path=>['newer','equal','rollback'].map(clock=>({path,clock}))))('preserves received quota and its unsettled worker across reset waits (%j)',async({path,clock})=>{
 const f=fixture(),scope=workspaceModelScopes(f.account)[0]!,now=Date.now(),key=JSON.stringify([scope.id,'gpt-5']);
 const baseline:QuotaCacheEntry={updatedAt:now-100,status:200,model:'gpt-5',primary:{usedPercent:100,resetAtMs:now+60000},secondary:{usedPercent:70},planType:'pro'};
 const observations=new Map([[key,baseline]]),scheduler=new PreemptiveQuotaScheduler();
 const quotaForReset=(_account:unknown,_scope:unknown,reset:QuotaCacheEntry)=>Object.assign(scheduler.getResetSnapshot(scope.id,'original-owner',reset,observations.get(key)),{model:'gpt-5'});
 const snapshot={updatedAt:now-10,accountId:scope.accountId,ordinaryUsageAllowed:true,credits:1,primary:{usedPercent:0},secondary:{usedPercent:0},planType:'pro',credentialOwner:resetCredentialOwner(f.account,scope.accountId)};
 f.account.rateLimitResetTimes={codex:now+60000};f.account.lastRateLimitReason='quota';
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const held=withAccountStorageTransaction(async()=>{entered();await gate;});await ready;
 const pending=path==='apply'?applyConfirmedReset({account:f.account,scope,model:'gpt-5',family:'codex',manager:f.manager,snapshot,lastRedemptionAt:now,observations,quotaForReset,now}):recoverResetQuota({model:'gpt-5',native:true,pinned:false,manager:f.manager,scopes:new Map([[0,[scope]]]),quotaForScope:()=>baseline,quotaForReset,service:{automatic:async()=>null,status:async()=>({snapshots:{[scope.id]:snapshot}})},observations,now:()=>now});
 const exhausted={updatedAt:clock==='equal'?now-10:clock==='rollback'?now-1000:now-1,status:200,primary:{usedPercent:100,resetAtMs:now+120000},secondary:{},planType:'team'};
 const receipt=scheduler.receive(scope.id,exhausted,'original-owner',baseline);
 const visible=scheduler.observeReceipt(scope.id,receipt,baseline)!;observations.set(key,Object.assign(visible,{model:'gpt-5'}));
 const sibling=scheduler.receive('sibling-model',{...exhausted,secondary:{usedPercent:99}},'sibling-owner');scheduler.observeReceipt('sibling-model',sibling);
 const worker=withAccountStorageTransaction(async()=>{
  const merged=scheduler.observeReceipt(scope.id,receipt,observations.get(key));expect(merged).toBeDefined();
  if(!merged)throw Error('Original received quota lost its epoch');
  observations.set(key,Object.assign(merged,{model:'gpt-5'}));
  await saveQuotaCache({byAccountId:{},byEmail:{},byWorkspace:{[scope.id]:observations.get(key)!}});
  scheduler.settleReceipt(scope.id,receipt,true,merged);
 });
 try{release();await held;expect(await pending).toBe(false);await worker;
  expect(observations.get(key)).toMatchObject({primary:{usedPercent:100,resetAtMs:now+120000},secondary:{usedPercent:70},planType:'team'});
  expect(f.account.rateLimitResetTimes.codex).toBe(now+60000);
  expect(scheduler.getDeferral(scope.id,now,'original-owner',observations.get(key)).defer).toBe(true);
  expect(scheduler.getDeferral('sibling-model',now,'sibling-owner').defer).toBe(true);
  expect((await loadQuotaCache()).byWorkspace?.[scope.id]?.primary.usedPercent).toBe(100);
 }finally{release();await held;await pending;await worker;}
});

it('publishes a genuinely newer healthy reset without retiring independent received fields',async()=>{
 const f=fixture(),scope=workspaceModelScopes(f.account)[0]!,scheduler=new PreemptiveQuotaScheduler(),now=Date.now();
 const baseline={updatedAt:now,status:200,primary:{usedPercent:100,resetAtMs:now+60000},secondary:{usedPercent:80}};
 const exhausted=scheduler.receive(scope.id,baseline,'owner');scheduler.observeReceipt(scope.id,exhausted);
 const healthy=scheduler.receive(scope.id,{updatedAt:now-1000,status:200,primary:{usedPercent:0},secondary:{}},'owner',baseline);
 const applied=scheduler.observeReceipt(scope.id,healthy,baseline)!;scheduler.settleReceipt(scope.id,healthy,true,applied);
 expect(applied).toMatchObject({primary:{usedPercent:0},secondary:{usedPercent:80}});
 expect(scheduler.getDeferral(scope.id,now,'owner',applied).defer).toBe(false);
 const observations=new Map<string,QuotaCacheEntry>();
 const snapshot={updatedAt:now,ordinaryUsageAllowed:true,accountId:scope.accountId,credits:0,primary:{usedPercent:0},secondary:{},credentialOwner:resetCredentialOwner(f.account,scope.accountId)};
 expect(await applyConfirmedReset({account:f.account,scope,manager:f.manager,model:'gpt-5',family:'codex',snapshot,lastRedemptionAt:0,observations,quotaForReset:()=>Object.assign(applied,{model:'gpt-5'}),now})).toBe(true);
 expect(observations.get(JSON.stringify([scope.id,'gpt-5']))?.secondary.usedPercent).toBe(80);
});

it('accepts a later healthy native read after exhausted received quota without reusing the old receipt',async()=>{
 const f=fixture(),scope=workspaceModelScopes(f.account)[0]!,scheduler=new PreemptiveQuotaScheduler(),now=Date.now();await backend();
 let current:QuotaCacheEntry={updatedAt:now,status:200,model:'gpt-5',primary:{usedPercent:100,resetAtMs:now+120000},secondary:{usedPercent:80},planType:'team'};
 const old=scheduler.receive(scope.id,current,'owner',current);
 current=Object.assign(scheduler.observeReceipt(scope.id,old,current)!,{model:'gpt-5'});scheduler.settleReceipt(scope.id,old,true,current);
 const service=createResetCreditService(f.manager,(_target,snapshot)=>{
  const receipt=scheduler.receive(scope.id,resetSnapshotQuota(snapshot),'owner',current);
  return()=>{const merged=scheduler.observeReceipt(scope.id,receipt,current);if(!merged)throw Error('Owned reset receipt lost');current=Object.assign(merged,{model:'gpt-5'});scheduler.settleReceipt(scope.id,receipt,true,current);};
 });
 const snapshots=await service.refresh([f.target]);
 const observations=new Map<string,QuotaCacheEntry>();
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:now+120000};
 expect(await recoverResetQuota({manager:f.manager,model:'gpt-5',family:'codex',native:true,pinned:false,scopes:new Map([[f.account.index,[scope]]]),quotaForScope:()=>({...old.snapshot,model:'gpt-5'}),service:{automatic:async()=>null,status:async()=>({snapshots})},observations,quotaForReset:(_account,_scope,reset)=>Object.assign(scheduler.getResetSnapshot(scope.id,'owner',reset,current),{model:'gpt-5'}),now:Date.now})).toBe(true);
 expect(current).toMatchObject({primary:{usedPercent:0},secondary:{usedPercent:0}});
 expect(scheduler.getDeferral(scope.id,Date.now(),'owner',current).defer).toBe(false);
 expect(scheduler.observeReceipt(scope.id,old,current)).toBeUndefined();
 expect(f.account.rateLimitResetTimes).toEqual({});expect(operations()).toHaveLength(1);await cleanBackend();
});

it('keeps newer primary ingress while a real healthy native reset publishes independent fields',async()=>{
 const f=fixture(),scope=workspaceModelScopes(f.account)[0]!,scheduler=new PreemptiveQuotaScheduler(),now=Date.now();await backend();
 let current:QuotaCacheEntry={updatedAt:now-100,status:200,model:'gpt-5',primary:{usedPercent:100,resetAtMs:now+60000},secondary:{usedPercent:80},planType:'team'};
 const initial=scheduler.receive(scope.id,current,'owner',current);current=Object.assign(scheduler.observeReceipt(scope.id,initial,current)!,{model:'gpt-5'});scheduler.settleReceipt(scope.id,initial,true,current);
 let release!:()=>void,entered!:()=>void,received!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;}),receiptReady=new Promise<void>(r=>{received=r;});
 const service=createResetCreditService(f.manager,(_target,snapshot)=>{
  const receipt=scheduler.receive(scope.id,resetSnapshotQuota(snapshot),'owner',current);received();
  return()=>{const merged=scheduler.observeReceipt(scope.id,receipt,current);if(merged)current=Object.assign(merged,{model:'gpt-5'});scheduler.settleReceipt(scope.id,receipt,true,current);};
 });
 const held=withFileTransactionLock(service.path,async()=>{entered();await gate;});await ready;
 const pending=service.refresh([f.target]);await receiptReady;
 const newest=scheduler.receive(scope.id,{updatedAt:now-1000,status:200,primary:{usedPercent:100,resetAtMs:now+120000},secondary:{},planType:'business'},'owner',current);current=Object.assign(scheduler.observeReceipt(scope.id,newest,current)!,{model:'gpt-5'});
 try{release();await held;await pending;
  expect(current).toMatchObject({primary:{usedPercent:100,resetAtMs:now+120000},secondary:{usedPercent:0},planType:'business'});
  expect(scheduler.observeReceipt(scope.id,newest,current)).toBeDefined();scheduler.settleReceipt(scope.id,newest,true,current);
  expect(scheduler.getDeferral(scope.id,Date.now(),'owner',current).defer).toBe(true);
 }finally{release();await held;await pending;await cleanBackend();}
});

const mutations=['workspace-disabled','workspace-removed','workspace-selection','account-disabled','access','refresh','expiry','code-only','nonpositive-revocation','record','removed','primary-missing','reset','journal','member','path','unknown-root'] as const;
async function mutate(f:ReturnType<typeof fixture>,mutation:typeof mutations[number]){
 const row=f.storage.accounts[0]!;
 if(mutation==='workspace-disabled'){row.workspaces![0]!.enabled=false;f.account.workspaces![0]!.enabled=false;}
 if(mutation==='workspace-removed'){row.workspaces=[];f.account.workspaces=[];}
 if(mutation==='workspace-selection'){row.currentWorkspaceIndex=1;f.account.currentWorkspaceIndex=1;}
 if(mutation==='account-disabled'){row.enabled=false;f.account.enabled=false;}
 if(mutation==='access'){row.accessToken='replacement';f.account.access='replacement';}
 if(mutation==='refresh'){row.refreshToken='replacement';f.account.refreshToken='replacement';}
 if(mutation==='expiry'){row.expiresAt!+=1;f.account.expires=row.expiresAt;}
 if(mutation==='code-only')row.authInvalidationErrorCode='token_invalidated';
 if(mutation==='nonpositive-revocation')row.authInvalidatedAt=0;
 if(mutation==='record'){row.recordId='replacement';f.account.recordId='replacement';}
 if(mutation==='removed')f.storage.accounts=[];
 writeAccountSourceFixture(f.storage,f.path);
 if(mutation==='primary-missing')await removeWithRetry(f.path,{force:true});
 if(mutation==='reset')await writeFile(f.path+'.reset-intent','{}');
 if(mutation==='journal')await writeFile(getPendingAuthPath(f.path),'{broken');
 if(mutation==='member')f.account.index=10;
 if(mutation==='path')vi.spyOn(f.manager,'resolveSelectionStoragePath').mockReturnValue(join(dir,'different.json'));
 if(mutation==='unknown-root')await writeFile(f.path+'.bak','{broken');
}
for(const action of ['read','consume'] as const){
 it.each(mutations)(`denies ${action} after %s during native initialization`,async mutation=>{
  const f=fixture();await backend(action==='read'?1:2);
  const pending=action==='read'?f.service.refresh([f.target]):f.service.redeem(f.target).catch(error=>error);
  await ready(`initialized-${action==='read'?1:2}`);
  await mutate(f,mutation);await writeFile(join(dir,'release-init'),'ready');
  const result=await pending;
  if(action==='read')expect(result).toEqual({});else expect(result).toBeInstanceOf(Error);
  expect(operations().filter(row=>row.method===`account/${action==='read'?'rateLimits/read':'rateLimitResetCredit/consume'}`)).toHaveLength(0);
  const state=await f.service.status();expect(state.lastRedemption).toBeUndefined();
  if(action==='read')expect(state.snapshots).toEqual({});
  await cleanBackend();
 },15000);
}
it('accepts current read, consume and follow-up read with one target and idempotency key',async()=>{
 const f=fixture();await backend();
 expect(await f.service.redeem(f.target)).toBe('reset');
 expect(operations().map(row=>row.method)).toEqual(['account/rateLimits/read','account/rateLimitResetCredit/consume','account/rateLimits/read']);
 expect(operations()[1]?.params.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
 const state=await f.service.status();expect(state.pending).toBeUndefined();expect(state.lastRedemption?.key).toBe(f.target.key);
 expect(state.snapshots[f.target.key]?.credentialOwner).toBe(resetCredentialOwner(f.account,f.target.accountId));
 expect(JSON.stringify(state)).not.toContain('fixture-access');expect(JSON.stringify(state)).not.toContain('fixture-refresh');
 await cleanBackend();
});
it.each(['expiry','access','code-only','workspace-disabled','journal','reset'] as const)('rejects read observations after %s during the response',async mutation=>{
 const f=fixture();await backend(0,1);
 const pending=f.service.refresh([f.target]);await ready('received-1');
 await mutate(f,mutation);await writeFile(join(dir,'release-response'),'ready');
 expect(await pending).toEqual({});expect((await f.service.status()).snapshots).toEqual({});expect(operations()).toHaveLength(1);await cleanBackend();
});
it('retains the original pending key after a sent consume loses its credential authority',async()=>{
 const f=fixture();await backend(0,2);
 const pending=f.service.redeem(f.target).catch(error=>error);await ready('received-2');
 const original=(await f.service.status()).pending!;
 await mutate(f,'access');await writeFile(join(dir,'release-response'),'ready');
 expect(await pending).toBeInstanceOf(Error);
 expect((await f.service.status()).pending).toEqual(original);expect((await f.service.status()).lastRedemption).toBeUndefined();
 expect(operations()).toHaveLength(2);
 await expect(createResetCreditService(f.manager).redeem(f.target)).rejects.toThrow(/original outcome/);
 expect(operations()).toHaveLength(2);expect((await f.service.status()).pending).toEqual(original);await cleanBackend();
});
it('rejects an observation after authority changes while waiting for its publication lock',async()=>{
 const f=fixture();await backend();
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),locked=new Promise<void>(resolve=>entered=resolve);
 const holder=withFileTransactionLock(join(dir,'reset-credits.json'),async()=>{entered();await gate;});await locked;
 const pending=f.service.refresh([f.target]);await ready('received-1');await cleanBackend();
 await mutate(f,'expiry');release();await holder;
 expect(await pending).toEqual({});expect((await f.service.status()).snapshots).toEqual({});expect(operations()).toHaveLength(1);
});
it('does not apply a persisted A snapshot to replacement B',async()=>{
 const f=fixture();await backend();const snapshots=await f.service.refresh([f.target]);
 const scope=workspaceModelScopes(f.account)[0]!;await mutate(f,'access');
 f.account.lastRateLimitReason='quota';const until=Date.now()+90000;f.account.rateLimitResetTimes={codex:until};
 const observations=new Map();const clear=vi.fn();
 expect(await applyConfirmedReset({account:f.account,scope,model:'gpt-5',family:'codex',manager:f.manager,snapshot:snapshots[f.target.key],lastRedemptionAt:0,observations,quotaForReset:(_account,_scope,reset)=>reset,now:Date.now()})).toBe(false);
 expect(observations.size).toBe(0);expect(f.account.rateLimitResetTimes.codex).toBe(until);expect(clear).not.toHaveBeenCalled();
});
it('retains B restrictions when automatic recovery waits for local status',async()=>{
 const f=fixture();await backend();await f.service.refresh([f.target]);const scope=workspaceModelScopes(f.account)[0]!;
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),readyStatus=new Promise<void>(resolve=>entered=resolve);
 const service={automatic:async()=>null,status:async()=>{entered();await gate;return f.service.status();}};
 const until=Date.now()+90000;f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:until};
 const observations=new Map();const clear=vi.fn();
 const pending=recoverResetQuota({model:'gpt-5',native:true,pinned:false,manager:f.manager,scopes:new Map([[0,[scope]]]),quotaForScope:()=>({updatedAt:0,status:200,model:'gpt-5',primary:{usedPercent:100},secondary:{}}),service,observations,quotaForReset:(_account,_scope,reset)=>reset,now:Date.now});
 await readyStatus;await mutate(f,'access');release();
 expect(await pending).toBe(false);expect(observations.size).toBe(0);expect(f.account.rateLimitResetTimes.codex).toBe(until);expect(clear).not.toHaveBeenCalled();
});
it('revalidates a manual reset application after its pool transaction wait',async()=>{
 const f=fixture();await backend();const snapshots=await f.service.refresh([f.target]);const scope=workspaceModelScopes(f.account)[0]!;
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),locked=new Promise<void>(resolve=>entered=resolve);
 const holder=withAccountStorageTransaction(async()=>{entered();await gate;});await locked;
 const until=Date.now()+90000;f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:until};
 const observations=new Map();const clear=vi.fn();
 const pending=applyConfirmedReset({account:f.account,scope,model:'gpt-5',family:'codex',manager:f.manager,snapshot:snapshots[f.target.key],lastRedemptionAt:0,observations,quotaForReset:(_account,_scope,reset)=>reset,now:Date.now()});
 await mutate(f,'expiry');release();await holder;
 expect(await pending).toBe(false);expect(observations.size).toBe(0);expect(f.account.rateLimitResetTimes.codex).toBe(until);expect(clear).not.toHaveBeenCalled();
});
it('retains an original source through a legitimate owned refresh and native redemption',async()=>{
 const f=fixture();f.storage.accounts[0]!.expiresAt=Date.now()+10000;f.account.expires=f.storage.accounts[0]!.expiresAt;writeAccountSourceFixture(f.storage);
 const refresh=await import('../lib/refresh-queue.js');
 const queued=vi.spyOn(refresh,'queuedRefresh').mockResolvedValue({type:'success',access:'owned-rotated-access',refresh:'owned-rotated-refresh',expires:Date.now()+7200000});
 await backend();
 expect(await f.service.redeem(f.target)).toBe('reset');expect(queued).toHaveBeenCalledTimes(1);
 expect(f.account.access).toBe('owned-rotated-access');
 const durable=JSON.parse(readFileSync(f.path,'utf8'));expect(durable.accounts[0].accessToken).toBe('owned-rotated-access');
 expect((await f.service.status()).snapshots[f.target.key]?.credentialOwner).toBe(resetCredentialOwner(f.account,f.target.accountId));
 expect(operations()).toHaveLength(3);await cleanBackend();
});

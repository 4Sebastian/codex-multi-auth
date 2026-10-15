import {afterEach, expect, it, vi} from "vitest";
import {promises as fs} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import WebSocket from "ws";
import {AccountManager} from "../lib/accounts.js";
import {setStoragePathDirect, type AccountStorageV3} from "../lib/storage.js";
import {recordPendingAuth, getPendingAuthPath} from "../lib/storage/pending-auth.js";
import {startRuntimeRotationProxy} from "../lib/runtime-rotation-proxy.js";
import {removeWithRetry} from "./helpers/remove-with-retry.js";
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();setStoragePathDirect(null);for(const root of roots.splice(0)) await removeWithRetry(root,{recursive:true,force:true});});
it.each(["EACCES","corrupt","clock-skew"])("denies native HTTP and WebSocket managed auth when journal is unreadable (%s)",async failure=>{
 const root=await fs.mkdtemp(join(tmpdir(),"journal-auth-"));roots.push(root);const path=join(root,"accounts.json");setStoragePathDirect(path);
 const bearer=failure === "clock-skew" ? `e30.${Buffer.from(JSON.stringify({iat:Math.floor(Date.now()/1000)+30})).toString("base64url")}.fixture` : "fixture-bearer";
 const pool:AccountStorageV3={version:3,activeIndex:0,accounts:[{recordId:"fixture",accountId:"fixture",accessToken:bearer,refreshToken:"fixture-refresh",expiresAt:Date.now()+3600000,addedAt:1,lastUsed:1}]};
 await fs.writeFile(path,JSON.stringify(pool));
 const manager=new AccountManager(undefined,pool), fetched=vi.fn(async()=>Response.json({models:[{slug:"shared"}]}));
 const proxy=await startRuntimeRotationProxy({nativeOpenai:true,accountManager:manager,readNativeAccountStorage:async()=>structuredClone(pool),clientApiKey:"fixture-independent",fetchImpl:fetched,upstreamBaseUrl:"http://127.0.0.1:1",readApiRoutes:async()=>[{id:"fixture-route",label:"Fixture",kind:"api",apiKey:"fixture-key",enabled:true,priority:0,visibleModels:["shared"]}]});
 try {
  const warm=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:`Bearer ${bearer}`}});expect(warm.status).toBe(200);await warm.text();fetched.mockClear();
  await recordPendingAuth(path,{recordId:"fixture",priorRefreshToken:"fixture-refresh",refreshToken:"fixture-refresh",accessToken:bearer,expiresAt:pool.accounts[0]!.expiresAt!,authInvalidatedAt:1500,enabled:false,at:1});
  const journal=await fs.readFile(getPendingAuthPath(path),"utf8"), read=fs.readFile.bind(fs);
  const blocked=vi.spyOn(fs,"readFile").mockImplementation(async(...args:Parameters<typeof fs.readFile>)=>{if(String(args[0])===getPendingAuthPath(path)) throw Object.assign(Error("fixture locked"),{code:"EACCES"});return read(...args);});
  if(failure==="corrupt"){blocked.mockRestore();await fs.writeFile(getPendingAuthPath(path),"corrupt fixture");}
  if(failure==="clock-skew") blocked.mockRestore();
  const denied=await fetch(`${proxy.baseUrl}/responses`,{method:"POST",headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json"},body:JSON.stringify({model:"api/shared",input:[]})});expect(denied.status).toBe(401);await denied.text();
  const status=await new Promise<number>((resolve,reject)=>{const socket=new WebSocket(proxy.baseUrl.replace("http:","ws:")+"/responses",{headers:{authorization:`Bearer ${bearer}`}});socket.on("error",()=>undefined);socket.once("unexpected-response",(_req,response)=>{response.resume();socket.terminate();resolve(response.statusCode!);});socket.once("open",()=>{socket.terminate();reject(Error("Unexpected managed upgrade"));});});expect(status).toBe(401);expect(fetched).not.toHaveBeenCalled();
  blocked.mockRestore();await fs.writeFile(getPendingAuthPath(path),journal);
  const stillDenied=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:`Bearer ${bearer}`}});expect(stillDenied.status).toBe(401);await stillDenied.text();
  await fs.rm(getPendingAuthPath(path));
  const recovered=await fetch(`${proxy.baseUrl}/models`,{headers:{authorization:`Bearer ${bearer}`}});expect(recovered.status).toBe(200);await recovered.text();
 } finally {await proxy.close();await manager.flushPendingSave();}
});

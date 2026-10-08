import {afterAll,beforeAll,expect,test} from "bun:test";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {AccessGrant,CreateSessionRequest,OPENGENI_API_CONTRACT_HEADER,OPENGENI_API_CONTRACT_REVISION,signDelegatedAccessToken} from "@opengeni/contracts";
import {bootstrapWorkspace,completeFileUpload,createDb,getSession,getTemporaryModelImageFile,listTemporaryModelImageCleanup,withSessionRlsActorContext} from "@opengeni/db";
import {MemoryEventBus,testSettings} from "@opengeni/testing";
import type {SessionWorkflowClient} from "@opengeni/core";
import type {ObjectStorage} from "@opengeni/storage";
import {createApp} from "../src/app";

// The caller supplies its own PG17 disposable database; this never boots or mutates the shared PG16 harness.
// Storage is scripted here: this proves native admission/custody/HTTP cleanup, not external object deletion or model inference.
let client:ReturnType<typeof createDb>,app:ReturnType<typeof createApp>;
const secret=randomBytes(32).toString("hex");
let failDelete=false;
const deleted:string[]=[];
beforeAll(()=>{
 const databaseUrl=process.env.OPENGENI_EVIDENCE_ASSESSOR_TEST_APP_URL;
 if(!databaseUrl)throw new Error("Own PostgreSQL17 evidence-assessor test database is required");
 client=createDb(databaseUrl,{max:2});
 const noop=async()=>undefined;
 app=createApp({settings:testSettings({databaseUrl,productAccessMode:"managed",delegationSecret:secret,sandboxBackend:"none",environment:"development"}),
  db:client.db,bus:new MemoryEventBus(),workflowClient:{signalUserMessage:noop,wakeSessionWorkflow:noop,requestSessionWorkflowWakeDispatch:noop,
   signalApprovalDecision:noop,syncScheduledTask:noop,deleteScheduledTaskSchedule:noop,triggerScheduledTask:noop,startRigVerification:noop} satisfies SessionWorkflowClient,
  objectStorage:{bucket:"synthetic-assessor",backend:"s3-compatible",maxSinglePutSizeBytes:10*1024*1024,
   createPutUrl:async()=>({url:"https://example.test/synthetic-upload",expiresAt:new Date(Date.now()+30_000),requiredHeaders:{}}),
   deleteObject:async(key:string)=>{if(failDelete)throw new Error("Synthetic cleanup dependency unavailable");deleted.push(key);},
  } as unknown as ObjectStorage});
});
afterAll(async()=>{await client?.close();});
async function request(grant:ReturnType<typeof AccessGrant.parse>,method:string,path:string,body?:unknown){
 const token=await signDelegatedAccessToken(secret,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId,
  principalKind:"human_session",permissions:grant.permissions,exp:Math.floor(Date.now()/1000)+600});
 return app.request(path,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",[OPENGENI_API_CONTRACT_HEADER]:OPENGENI_API_CONTRACT_REVISION},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
test("native temporary images bind uploader/session, reject unrelated owners and revoke reads before retriable cleanup",async()=>{
 const nonce=randomUUID();const access=await bootstrapWorkspace(client.db,{accountExternalSource:"assessor-image-test",accountExternalId:nonce,accountName:"Synthetic assessor",
  workspaceExternalSource:"assessor-image-test",workspaceExternalId:nonce,workspaceName:"Synthetic assessor",subjectId:`assessor:${nonce}`});
 const grant=AccessGrant.parse(access.workspaceGrants[0]);const sessionId=randomUUID(),fileId=randomUUID();
 const base=`/v1/workspaces/${grant.workspaceId}/files`;
 const photo=Uint8Array.from([137,80,78,71,13,10,26,10]);
 const response=await request(grant,"POST",`${base}/uploads`,{requestedFileId:fileId,temporaryForSessionId:sessionId,scope:"workspace",filename:"input-image",
  contentType:"image/png",sizeBytes:photo.length,sha256:createHash("sha256").update(photo).digest("hex")});
 expect(response.status).toBe(201);
 const upload=await response.json();expect(upload.fileId).toBe(fileId);
 const custody={accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId,sessionId,fileId};
 const read=()=>withSessionRlsActorContext({subjectId:grant.subjectId,privateFileOwnerSubjectId:null},()=>getTemporaryModelImageFile(client.db,custody));
 await withSessionRlsActorContext({subjectId:grant.subjectId,privateFileOwnerSubjectId:null},()=>completeFileUpload(client.db,grant.workspaceId,upload.uploadId));
 expect((await read())?.status).toBe("ready");
 expect(await getTemporaryModelImageFile(client.db,{...custody,subjectId:`unrelated:${nonce}`})).toBeNull();
 expect(await getTemporaryModelImageFile(client.db,{...custody,sessionId:randomUUID()})).toBeNull();
 const payload=CreateSessionRequest.parse({requestedSessionId:sessionId,idempotencyKey:sessionId,initialMessage:"Synthetic bounded image check",model:"scripted-model",
  rigId:null,variableSetIds:[],sandboxBackend:"none",visibility:"workspace",agentAccess:"session",memoryScope:"off",policyRole:"evidence-assessor",resources:[{kind:"file",fileId,asImage:true}],
  maxOutputTokens:400,metadata:{nativeMaxOutputTokens:9999},tools:[],mcpServers:[],firstPartyMcpTools:[],bundledSkillIds:[],skills:[]});
 const unsafe=await request(grant,"POST",`/v1/workspaces/${grant.workspaceId}/sessions`,{...payload,memoryScope:"workspace"});expect(unsafe.status).toBe(422);
 const created=await request(grant,"POST",`/v1/workspaces/${grant.workspaceId}/sessions`,payload);expect(created.status).toBe(202);
 const stored=await getSession(client.db,grant.workspaceId,sessionId);expect(stored?.metadata.nativeMaxOutputTokens).toBe(400);
 expect(stored?.resources.map(resource=>Object.fromEntries(Object.keys(payload.resources[0]!).map(key=>[key,resource[key as keyof typeof resource]])))).toEqual(payload.resources);
 expect((await read())?.status).toBe("ready");
 const ordinaryId=randomUUID();const {maxOutputTokens:_removed,...ordinary}=payload;
 const ordinaryCreated=await request(grant,"POST",`/v1/workspaces/${grant.workspaceId}/sessions`,{...ordinary,requestedSessionId:ordinaryId,idempotencyKey:ordinaryId,resources:[]});
 expect(ordinaryCreated.status).toBe(202);expect((await getSession(client.db,grant.workspaceId,ordinaryId))?.metadata.nativeMaxOutputTokens).toBeUndefined();
 const initialPending=await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId});
 expect(initialPending).toEqual([]);
 const unrelated=await request({...grant,subjectId:`unrelated:${nonce}`} ,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`);expect(unrelated.status).toBe(404);
 failDelete=true;const failed=await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`);expect(failed.status).toBe(500);
 expect((await read())?.status).toBe("failed");expect(deleted).toHaveLength(0);
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 failDelete=false;const removed=await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`);expect(removed.status).toBe(204);
 expect(deleted).toHaveLength(1);
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([]);
 const denied=await request(grant,"POST",`${base}/${fileId}/download-url`,{});expect(denied.status).toBe(409);
},60_000);

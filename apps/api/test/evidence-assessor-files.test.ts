import {afterAll,beforeAll,expect,test} from "bun:test";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {AccessGrant,CreateSessionRequest,OPENGENI_API_CONTRACT_HEADER,OPENGENI_API_CONTRACT_REVISION,signDelegatedAccessToken} from "@opengeni/contracts";
import {bootstrapWorkspace,completeFileUpload,getFileUpload,createDb,getSession,getTemporaryModelImageFile,listTemporaryModelImageCleanup,withWorkspaceRls,withSessionRlsActorContext} from "@opengeni/db";
import {MemoryEventBus,testSettings} from "@opengeni/testing";
import type {SessionWorkflowClient} from "@opengeni/core";
import type {ObjectStorage} from "@opengeni/storage";
import {fileUploads} from "@opengeni/db/schema";
import {and,eq} from "drizzle-orm";
import {createFileUploadReaperActivities,FILE_UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS} from "../../worker/src/activities/file-upload-reaper";
import type {ControlActivityServices} from "../../worker/src/activities/types";
import {createApp} from "../src/app";

// The caller supplies its own PG17 disposable database; this never boots or mutates the shared PG16 harness.
// Storage is scripted here: this proves native admission/custody/HTTP cleanup, not external object deletion or model inference.
let client:ReturnType<typeof createDb>,app:ReturnType<typeof createApp>,storage:ObjectStorage;
const secret=randomBytes(32).toString("hex");
let failDelete=false;
const deleted:string[]=[];
const liveObjects=new Set<string>();
const photo=Uint8Array.from([137,80,78,71,13,10,26,10]);
const photoSha=createHash("sha256").update(photo).digest("hex");
beforeAll(()=>{
 const databaseUrl=process.env.OPENGENI_EVIDENCE_ASSESSOR_TEST_APP_URL;
 if(!databaseUrl)throw new Error("Own PostgreSQL17 evidence-assessor test database is required");
 client=createDb(databaseUrl,{max:2});
 const noop=async()=>undefined;
 storage={bucket:"synthetic-assessor",backend:"s3-compatible",maxSinglePutSizeBytes:10*1024*1024,
   createPutUrl:async({key,expiresInSeconds}:{key:string;expiresInSeconds?:number})=>{expect(expiresInSeconds).toBe(30);liveObjects.add(key);return {url:"https://example.test/synthetic-upload",expiresAt:new Date(Date.now()+30_000),requiredHeaders:{}};},
   fileExists:async()=>true,headFile:async()=>({ContentLength:photo.length,ContentType:"image/png",Metadata:{sha256:photoSha}}),
   deleteObject:async(key:string)=>{if(failDelete)throw new Error("Synthetic cleanup dependency unavailable");deleted.push(key);liveObjects.delete(key);},
  } as unknown as ObjectStorage;
 app=createApp({settings:testSettings({databaseUrl,productAccessMode:"managed",delegationSecret:secret,sandboxBackend:"none",environment:"development"}),
  db:client.db,bus:new MemoryEventBus(),workflowClient:{signalUserMessage:noop,wakeSessionWorkflow:noop,requestSessionWorkflowWakeDispatch:noop,
   signalApprovalDecision:noop,syncScheduledTask:noop,deleteScheduledTaskSchedule:noop,triggerScheduledTask:noop,startRigVerification:noop} satisfies SessionWorkflowClient,
  objectStorage:storage});
});
afterAll(async()=>{await client?.close();});
async function request(grant:ReturnType<typeof AccessGrant.parse>,method:string,path:string,body?:unknown){
 const token=await signDelegatedAccessToken(secret,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId,
  principalKind:"human_session",permissions:grant.permissions,exp:Math.floor(Date.now()/1000)+600});
 return app.request(path,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",[OPENGENI_API_CONTRACT_HEADER]:OPENGENI_API_CONTRACT_REVISION},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function expireSyntheticUpload(grant:ReturnType<typeof AccessGrant.parse>,uploadId:string){
 // Only this disposable synthetic database is advanced; no production expiry or clock is changed.
 await withWorkspaceRls(client.db,grant.workspaceId,async db=>{await db.update(fileUploads).set({expiresAt:new Date(Date.now()-1000)})
  .where(and(eq(fileUploads.workspaceId,grant.workspaceId),eq(fileUploads.id,uploadId)));});
}
test("native temporary images bind uploader/session, reject unrelated owners and revoke reads before retriable cleanup",async()=>{
 const nonce=randomUUID();const access=await bootstrapWorkspace(client.db,{accountExternalSource:"assessor-image-test",accountExternalId:nonce,accountName:"Synthetic assessor",
  workspaceExternalSource:"assessor-image-test",workspaceExternalId:nonce,workspaceName:"Synthetic assessor",subjectId:`assessor:${nonce}`});
 const grant=AccessGrant.parse(access.workspaceGrants[0]);const sessionId=randomUUID(),fileId=randomUUID();
 const base=`/v1/workspaces/${grant.workspaceId}/files`;
 const response=await request(grant,"POST",`${base}/uploads`,{requestedFileId:fileId,temporaryForSessionId:sessionId,scope:"workspace",filename:"input-image",
  contentType:"image/png",sizeBytes:photo.length,sha256:createHash("sha256").update(photo).digest("hex")});
 expect(response.status).toBe(201);
 const upload=await response.json();expect(upload.fileId).toBe(fileId);
 const custody={accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId,sessionId,fileId};
 const read=()=>withSessionRlsActorContext({subjectId:grant.subjectId,privateFileOwnerSubjectId:null},()=>getTemporaryModelImageFile(client.db,custody));
 await withSessionRlsActorContext({subjectId:grant.subjectId,privateFileOwnerSubjectId:null},()=>completeFileUpload(client.db,grant.workspaceId,upload.uploadId));
 expect((await read())?.status).toBe("ready");
 // Another actual workspace member is provisioned through the same native producer.
 const peerAccess=await bootstrapWorkspace(client.db,{accountExternalSource:"assessor-image-test",accountExternalId:nonce,accountName:"Synthetic assessor",
  workspaceExternalSource:"assessor-image-test",workspaceExternalId:nonce,workspaceName:"Synthetic assessor",subjectId:`peer:${nonce}`});
 const peerGrant=AccessGrant.parse(peerAccess.workspaceGrants[0]);
 const listed=await request(peerGrant,"GET",base);expect(listed.status).toBe(200);expect((await listed.json()).files.some((file:{id:string})=>file.id===fileId)).toBe(false);
 expect((await request(peerGrant,"POST",`${base}/${fileId}/download-url`,{})).status).toBe(404);
 const unrelatedSession=randomUUID();
 expect((await request(peerGrant,"POST",`/v1/workspaces/${grant.workspaceId}/sessions`,{requestedSessionId:unrelatedSession,initialMessage:"Synthetic ordinary attachment",rigId:null,sandboxBackend:"none",resources:[{kind:"file",fileId}]})).status).toBe(422);
 expect(await getTemporaryModelImageFile(client.db,{...custody,subjectId:`unrelated:${nonce}`})).toBeNull();
 expect(await getTemporaryModelImageFile(client.db,{...custody,sessionId:randomUUID()})).toBeNull();
 const payload=CreateSessionRequest.parse({requestedSessionId:sessionId,idempotencyKey:sessionId,initialMessage:"Synthetic bounded image check",model:"scripted-model",
  rigId:null,variableSetIds:[],sandboxBackend:"none",visibility:"workspace",agentAccess:"session",memoryScope:"off",policyRole:"evidence-assessor",resources:[{kind:"file",fileId,asImage:true}],
  maxOutputTokens:400,metadata:{nativeMaxOutputTokens:9999},tools:[],mcpServers:[],firstPartyMcpTools:[],bundledSkillIds:[],skills:[]});
 for(const policyRole of [undefined,CreateSessionRequest.parse({initialMessage:"Synthetic role control",policyRole:"ordinary-control"}).policyRole]){
  const invalidRole=await request(grant,"POST",`/v1/workspaces/${grant.workspaceId}/sessions`,{...payload,policyRole});
  expect(invalidRole.status).toBe(422);
 }
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
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 await expireSyntheticUpload(grant,upload.uploadId);
 expect((await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`)).status).toBe(204);
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 const denied=await request(grant,"POST",`${base}/${fileId}/download-url`,{});expect(denied.status).toBe(404);
},60_000);

test("pending image revoke fences late HTTP finalize and keeps retry custody",async()=>{
 const nonce=randomUUID();const access=await bootstrapWorkspace(client.db,{accountExternalSource:"assessor-image-test",accountExternalId:nonce,accountName:"Synthetic assessor",
  workspaceExternalSource:"assessor-image-test",workspaceExternalId:nonce,workspaceName:"Synthetic assessor",subjectId:`assessor:${nonce}`});
 const grant=AccessGrant.parse(access.workspaceGrants[0]);const sessionId=randomUUID(),fileId=randomUUID();
 const base=`/v1/workspaces/${grant.workspaceId}/files`;
 const response=await request(grant,"POST",`${base}/uploads`,{requestedFileId:fileId,temporaryForSessionId:sessionId,scope:"workspace",filename:"input-image",contentType:"image/png",sizeBytes:photo.length,sha256:photoSha});
 expect(response.status).toBe(201);const upload=await response.json();
 failDelete=true;
 expect((await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`)).status).toBe(500);
 failDelete=false;
 expect((await request(grant,"POST",`${base}/uploads/${upload.uploadId}/complete`,{})).status).toBe(409);
 const durable=await getFileUpload(client.db,grant.workspaceId,upload.uploadId);
 expect(durable?.status).toBe("cleanup_pending");expect(durable?.file.status).toBe("failed");
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 expect((await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`)).status).toBe(204);
 // A valid signed PUT can arrive after this successful delete: custody must remain.
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 expect((await request(grant,"POST",`${base}/${fileId}/download-url`,{})).status).toBe(404);
 if(!durable)throw new Error("Synthetic upload custody missing");
 liveObjects.add(durable.file.objectKey); // Scripted late PUT after the early delete.
 await expireSyntheticUpload(grant,upload.uploadId);
 expect((await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`)).status).toBe(204);
 expect(liveObjects.has(durable.file.objectKey)).toBe(false);
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 expect((await request(grant,"POST",`${base}/uploads/${upload.uploadId}/complete`,{})).status).toBe(409);
},60_000);

test("revoked image cleanup survives no later assessor through the installed reaper",async()=>{
 const nonce=randomUUID();const access=await bootstrapWorkspace(client.db,{accountExternalSource:"assessor-image-test",accountExternalId:nonce,accountName:"Synthetic assessor",
  workspaceExternalSource:"assessor-image-test",workspaceExternalId:nonce,workspaceName:"Synthetic assessor",subjectId:`assessor:${nonce}`});
 const grant=AccessGrant.parse(access.workspaceGrants[0]);const sessionId=randomUUID(),fileId=randomUUID();const base=`/v1/workspaces/${grant.workspaceId}/files`;
 const response=await request(grant,"POST",`${base}/uploads`,{requestedFileId:fileId,temporaryForSessionId:sessionId,scope:"workspace",filename:"input-image",contentType:"image/png",sizeBytes:photo.length,sha256:photoSha});
 expect(response.status).toBe(201);const upload=await response.json();
 await completeFileUpload(client.db,grant.workspaceId,upload.uploadId);
 expect((await request(grant,"DELETE",`${base}/${fileId}?temporaryForSessionId=${sessionId}`)).status).toBe(204);
 const durable=await getFileUpload(client.db,grant.workspaceId,upload.uploadId);if(!durable)throw new Error("Synthetic upload custody missing");
 liveObjects.add(durable.file.objectKey); // Scripted late PUT; the assessor never runs again.
 await withWorkspaceRls(client.db,grant.workspaceId,async db=>{await db.update(fileUploads).set({expiresAt:new Date(Date.now()-1000),updatedAt:new Date(Date.now()-FILE_UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS-1000)})
  .where(and(eq(fileUploads.workspaceId,grant.workspaceId),eq(fileUploads.id,upload.uploadId)));});
 const observability={info:()=>undefined,warn:()=>undefined};
 const reaper=createFileUploadReaperActivities(async()=>({db:client.db,objectStorage:storage,observability} as unknown as ControlActivityServices));
 const result=await reaper.reapExpiredFileUploads();expect(result.failed).toBe(0);
 expect(liveObjects.has(durable.file.objectKey)).toBe(false);
 // Observe the late completion even on the old terminalizing source.
 // A PUT that began before URL expiry can finish AFTER this reaper deletion.
 liveObjects.add(durable.file.objectKey);
 await withWorkspaceRls(client.db,grant.workspaceId,async db=>{await db.update(fileUploads).set({updatedAt:new Date(Date.now()-FILE_UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS-1000)})
  .where(and(eq(fileUploads.workspaceId,grant.workspaceId),eq(fileUploads.id,upload.uploadId)));});
 expect((await reaper.reapExpiredFileUploads()).failed).toBe(0);
 expect(liveObjects.has(durable.file.objectKey)).toBe(false);
 expect((await getFileUpload(client.db,grant.workspaceId,upload.uploadId))?.status).toBe("cleanup_pending");
 expect(result.deleted).toBeGreaterThan(0);
 expect(await listTemporaryModelImageCleanup(client.db,{accountId:grant.accountId,workspaceId:grant.workspaceId,subjectId:grant.subjectId})).toEqual([{fileId,sessionId}]);
 expect((await request(grant,"POST",`${base}/uploads/${upload.uploadId}/complete`,{})).status).toBe(409);
},60_000);

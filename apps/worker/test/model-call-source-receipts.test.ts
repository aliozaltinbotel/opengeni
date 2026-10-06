import { IMPORTED_HISTORY_CONTEXT_HEADER,MODEL_CALL_SOURCE_MAX_INPUTS, ModelSourceRef } from "@opengeni/contracts";
import { buildSummaryItem, buildCompactionPromptInput, buildRemoteCompactionV2PromptInput } from "@opengeni/runtime";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Usage, type ModelRequest, type Model, type StreamEvent } from "@openai/agents";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { applySessionTurnSettlement, ensureManagedAccessForUser, forkSessionContent, appendSessionHistoryItems, applyContextCompaction, bootstrapWorkspace, claimSessionWorkForAttempt, createDb, createSession, getActiveSessionHistoryItemsPaged, initializeSessionStartAtomically, getOrCreateCompanyProfileSnapshot, getOrCreateWorkspaceInstructionPolicySnapshot, getOrCreatePreferenceRegistrySnapshot, withSessionRlsActorContext, persistModelCallSourceReceipt, readModelCallSourceReceipt, recordModelCallFact, type ModelCallSourceIdentity } from "@opengeni/db";
import { ModelRequestCaptureModel, withModelRequestCapture, bindModelSourceInput, omitModelSourceInputBinding, modelSourceBindings, nativeModelSourceKeyForToolCall, type ModelRequestCapture } from "../../../packages/runtime/src/model-request-capture";
import { toPostgresLosslessJson } from "../../../packages/db/src/lossless-json";
let shared:SharedTestDatabase;
let app:ReturnType<typeof createDb>;
beforeAll(async()=>{const acquired=await acquireSharedTestDatabase("model-call-source-receipts");if(!acquired)throw Error("PostgreSQL required");shared=acquired;app=createDb(shared.appUrl,{max:4});},180_000);
afterAll(async()=>{await app?.close();await shared?.release();},60_000);
async function fixture(options:{metadata?:Record<string,unknown>;initialModelContext?:string;managed?:boolean}={}){
 const suffix=crypto.randomUUID();
 const userId=`native-source-${suffix}`;const subjectId=options.managed?`user:${userId}`:suffix;
 const access=options.managed?await ensureManagedAccessForUser(app.db,{userId,email:`${userId}@example.test`,name:"Synthetic owner"}):await bootstrapWorkspace(app.db,{accountExternalSource:"source-receipt",accountExternalId:suffix,accountName:"Test",workspaceExternalSource:"source-receipt",workspaceExternalId:suffix,workspaceName:"Test",subjectId:suffix});
 const {accountId,workspaceId}=access.workspaceGrants[0]!;if(!workspaceId)throw Error("workspace");
 const session=await createSession(app.db,{accountId,workspaceId,initialMessage:"Synthetic request",createdBy:{kind:"subject",subjectId},resources:[],metadata:options.metadata??{},...(options.initialModelContext?{initialModelContext:options.initialModelContext}:{}),model:"scripted",reasoningEffort:"low",latencyMode:"standard",sandboxBackend:"none"});
 await initializeSessionStartAtomically(app.db,{accountId,workspaceId,sessionId:session.id,reasoningEffortFallback:"low",createdEventPayload:{}});
 const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,workspaceId,{sessionId:session.id,workflowId:`session-${session.id}`,workflowRunId:crypto.randomUUID(),dispatchId:suffix,attemptId,trigger:{kind:"next"}});
 if(claim.action!=="claimed")throw Error("claim");
 const identity:ModelCallSourceIdentity={accountId,workspaceId,sessionId:session.id,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID(),requestIndex:1};
 const instructionSelections=await withSessionRlsActorContext({subjectId:"worker:source-receipt",initiatingHumanSubjectId:subjectId},async()=>{const profile=await getOrCreateCompanyProfileSnapshot(app.db,identity);const policy=await getOrCreateWorkspaceInstructionPolicySnapshot(app.db,identity);const preferences=await getOrCreatePreferenceRegistrySnapshot(app.db,identity);return {instructionPolicySnapshotId:policy.id,preferenceSnapshotId:preferences.id,companyProfileSnapshotId:profile.id};});
 return {identity,instructionSelections,subjectId,triggerEventId:claim.turn.triggerEventId,write:{accountId,workspaceId,sessionId:session.id,turnId:claim.turn.id,expectedAttemptId:attemptId,expectedExecutionGeneration:claim.turn.executionGeneration}};
}
function request(input:ModelRequest["input"]):ModelRequest{return {systemInstructions:"Synthetic instruction",input,tools:[],handoffs:[],modelSettings:{},outputType:"text",tracing:false};}
test("persistence removes only native source binding and keeps unknown symbols refused",()=>{
 const json={type:"message",role:"user",content:[{type:"input_text",text:"Synthetic exact bytes"}]};
 const owned=bindModelSourceInput({...json},{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:crypto.randomUUID(),sha256:"a".repeat(64)},parents:[],retainedSources:[]});
 const wire=omitModelSourceInputBinding(owned);expect(wire).toEqual(json);expect(JSON.stringify(wire)).toBe(JSON.stringify(owned));expect(modelSourceBindings([owned])).toHaveLength(1);expect(modelSourceBindings([wire])).toEqual([]);expect(toPostgresLosslessJson(wire)).toEqual(json);
 Object.defineProperty(owned,Symbol("unknown-owner"),{value:"untrusted",enumerable:true});expect(()=>toPostgresLosslessJson(omitModelSourceInputBinding(owned))).toThrow("Canonical JSON cannot contain symbol keys");
 const hidden=bindModelSourceInput({...json},{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:crypto.randomUUID(),sha256:"b".repeat(64)},parents:[],retainedSources:[]});Object.defineProperty(hidden,Symbol("unknown-hidden-owner"),{value:"untrusted",enumerable:false});expect(()=>toPostgresLosslessJson(omitModelSourceInputBinding(hidden))).toThrow("Canonical JSON cannot contain symbol keys");
});
test("real PostgreSQL commits exact-call proof before dispatch; persistence failure prevents dispatch",async()=>{
 const {identity,instructionSelections}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);let calls=0;
 const model:Model={async getResponse(){calls++;const stored=await readModelCallSourceReceipt(app.db,identity);expect(stored.receipt?.sourceKey).toBe(identity.sourceKey);expect(stored.receipt?.complete).toBe(true);expect(stored.receipt?.inputs.flatMap(item=>item.retainedSources).some(ref=>ref.owner==="workspace_instruction_policy_snapshots" && ref.id===instructionSelections.instructionPolicySnapshotId)).toBe(true);return {usage:new Usage(),output:[],responseId:"provider-1"};},async *getStreamedResponse():AsyncIterable<StreamEvent>{throw Error("unused");}};
 const capture:ModelRequestCapture=()=>{};capture.beforeCall=async sent=>{await persistModelCallSourceReceipt(app.db,identity,{instructions:sent.systemInstructions,input:sent.input,tools:sent.tools,instructionSelections});return identity.sourceKey;};
 await withModelRequestCapture(capture,()=>new ModelRequestCaptureModel(model).getResponse(request(rows.map(row=>row.item))));expect(calls).toBe(1);
 capture.beforeCall=async sent=>{await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),executionGeneration:identity.executionGeneration+1},{input:sent.input});return "unreachable";};
 await expect(withModelRequestCapture(capture,()=>new ModelRequestCaptureModel(model).getResponse(request(rows.map(row=>row.item))))).rejects.toThrow();expect(calls).toBe(1);
 const fact=await recordModelCallFact(app.db,{...identity,turnAttemptId:identity.attemptId,provider:"synthetic",providerApi:"responses",model:"scripted",billingPath:"external",pricedCostMicros:0});
 const [storedFact]=await shared.admin`select source_receipt_id from model_call_facts where id=${fact.id}`;expect(storedFact!.source_receipt_id).toBe((await readModelCallSourceReceipt(app.db,identity)).receipt!.id);
});
test("ordered transformed inputs retain producer row refs and input bytes; exact read is not latest",async()=>{
 const {identity}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const row=rows[0]!;expect(row.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
 const owned=bindModelSourceInput(row.item,{sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},kind:"HISTORY_ROW",parents:[],retainedSources:[]});const transformed={...owned,content:"Synthetic projection",id:"projected"};
 const first=await persistModelCallSourceReceipt(app.db,identity,{input:[transformed],sourceBindings:modelSourceBindings([transformed])});expect(first.complete).toBe(true);expect(first.inputs[0]!.sourceRef!.id).toBe(row.id);
 const second=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:2},{input:[{type:"message",role:"user",content:"New unknown source"}]});expect(second.complete).toBe(false);
 expect((await readModelCallSourceReceipt(app.db,identity)).receipt!.id).toBe(first.id);expect((await readModelCallSourceReceipt(app.db,{...identity,sourceKey:second.sourceKey})).receipt!.complete).toBe(false);
 expect((await readModelCallSourceReceipt(app.db,{...identity,sessionId:crypto.randomUUID()})).receipt).toBeNull();
});
test("portable summaries require the exact compaction call and retain recursive instructions and selections",async()=>{
 const {identity,write,instructionSelections}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const compaction=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID()},{purpose:"COMPACTION",instructions:"First compaction-only instruction",input:rows.map(row=>row.item),instructionSelections});expect(compaction.complete).toBe(true);
 await applyContextCompaction(app.db,{...write,replacementItems:[],summaryItem:buildSummaryItem("Synthetic summary"),summarySourceIds:rows.map(row=>row.id),summaryModelSourceKey:compaction.sourceKey});
 const compacted=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const first=await persistModelCallSourceReceipt(app.db,identity,{input:compacted.map(row=>row.item)});expect(first.complete).toBe(true);
 expect(first.closure.map(node=>node.sourceRef.id)).toContain(compaction.id);expect(first.closure.map(node=>node.sourceRef.id)).toContain(rows[0]!.id);
 expect(first.closure.flatMap(node=>node.retainedSources)).toContainEqual(compaction.inputs[0]!.retainedSources.find(ref=>ref.owner==="workspace_instruction_policy_snapshots")!);
 expect(first.closure.map(node=>node.sourceRef)).toContainEqual(compaction.inputs[0]!.sourceRef!);
 const repeated=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:2},{purpose:"COMPACTION",instructions:"Second compaction-only instruction",input:compacted.map(row=>row.item),instructionSelections});expect(repeated.complete).toBe(true);
 await applyContextCompaction(app.db,{...write,replacementItems:[],summaryItem:buildSummaryItem("Second summary"),summarySourceIds:compacted.map(row=>row.id),summaryModelSourceKey:repeated.sourceKey});
 const secondRows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const second=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:3},{input:secondRows.map(row=>row.item)});expect(second.complete).toBe(true);
 for(const receipt of [compaction,repeated]){expect(second.closure.map(node=>node.sourceRef)).toContainEqual({owner:"model_call_source_receipts",id:receipt.id,sha256:receipt.digest});expect(second.closure.map(node=>node.sourceRef)).toContainEqual(receipt.inputs[0]!.sourceRef!);}
 // The same valid row ancestry without its successful call parent is not sufficient proof.
 await applyContextCompaction(app.db,{...write,replacementItems:[],summaryItem:buildSummaryItem("Removed receipt parent"),summarySourceIds:secondRows.map(row=>row.id)});
 const historical=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const missing=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:4},{input:historical.map(row=>row.item)});expect(missing.complete).toBe(false);expect(missing.incompleteReasons).toContain("UNRESOLVED_PARENT");
});
test("compaction refuses missing, foreign, wrong-purpose and mismatched call identities",async()=>{
 const {identity,write}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const agent=await persistModelCallSourceReceipt(app.db,identity,{input:rows.map(row=>row.item)});const foreign=await fixture();const foreignRows=await getActiveSessionHistoryItemsPaged(app.db,foreign.identity.workspaceId,foreign.identity.sessionId);const foreignReceipt=await persistModelCallSourceReceipt(app.db,foreign.identity,{purpose:"COMPACTION",input:foreignRows.map(row=>row.item)});
 for(const sourceKey of [crypto.randomUUID(),foreignReceipt.sourceKey])await expect(applyContextCompaction(app.db,{...write,replacementItems:[],summaryItem:buildSummaryItem("Refused"),summarySourceIds:rows.map(row=>row.id),summaryModelSourceKey:sourceKey})).rejects.toThrow("COMPACTION_SOURCE_RECEIPT_UNAVAILABLE");
 await expect(applyContextCompaction(app.db,{...write,replacementItems:[],summaryItem:buildSummaryItem("Refused"),summarySourceIds:rows.map(row=>row.id),summaryModelSourceKey:agent.sourceKey})).rejects.toThrow("COMPACTION_SOURCE_RECEIPT_MISMATCH");
 const unrelated=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID()},{purpose:"COMPACTION",input:rows.map(row=>row.item)});
 await appendSessionHistoryItems(app.db,{...write,items:[{position:Math.max(...rows.map(row=>row.position))+1,item:buildSummaryItem("Mismatched call digest"),sourceBasis:{kind:"SUMMARY",parents:[{owner:"session_history_items",id:rows[0]!.id,sha256:rows[0]!.sourceSha256!},{owner:"model_call_source_receipts",id:unrelated.id,sha256:"0".repeat(64)}]}}]});
 const mismatched=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const refused=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID()},{input:mismatched.map(row=>row.item)});expect(refused.complete).toBe(false);expect(refused.incompleteReasons).toContain("UNRESOLVED_PARENT");
});
test("SDK tool IDs bind to the exact request and cannot borrow a previous request key",async()=>{
 const {identity}=await fixture();let index=0;
 const capture:ModelRequestCapture=()=>{};capture.beforeCall=async sent=>{const sourceKey=`${identity.sourceKey}-${++index}`;await persistModelCallSourceReceipt(app.db,{...identity,sourceKey,requestIndex:index},{input:sent.input});return sourceKey;};
 const inner:Model={async getResponse(){return {usage:new Usage(),responseId:`response-${index}`,output:[{type:"function_call",name:"synthetic",arguments:"{}",callId:`call-${index}`}]}},async *getStreamedResponse():AsyncIterable<StreamEvent>{throw Error("unused");}};
 const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 await withModelRequestCapture(capture,async()=>{const model=new ModelRequestCaptureModel(inner);await model.getResponse(request(rows.map(row=>row.item)));await model.getResponse(request(rows.map(row=>row.item)));expect(nativeModelSourceKeyForToolCall("call-1")).toBe(`${identity.sourceKey}-1`);expect(nativeModelSourceKeyForToolCall("call-2")).toBe(`${identity.sourceKey}-2`);expect(nativeModelSourceKeyForToolCall("missing")).toBeUndefined();});
 expect(nativeModelSourceKeyForToolCall("call-1")).toBeUndefined();
});

test("SDK imports without origin/truncated context remain incomplete; exact native source parents close",async()=>{
 const original=await fixture();const [parent]=await getActiveSessionHistoryItemsPaged(app.db,original.identity.workspaceId,original.identity.sessionId);if(!parent)throw Error("source");
 const source={source:"session_history_items",externalId:parent.id,sha256:parent.sourceSha256!};
 const createImported=async(origins:unknown[],context:string)=>{
  const session=await createSession(app.db,{accountId:original.identity.accountId,workspaceId:original.identity.workspaceId,initialMessage:"Synthetic follow-on",initialModelContext:context,resources:[],metadata:{nativeImportedHistoryOrigins:origins},model:"scripted",reasoningEffort:"low",latencyMode:"standard",sandboxBackend:"none"});
  await initializeSessionStartAtomically(app.db,{accountId:original.identity.accountId,workspaceId:original.identity.workspaceId,sessionId:session.id,reasoningEffortFallback:"low",createdEventPayload:{}});
  const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,original.identity.workspaceId,{sessionId:session.id,workflowId:`session-${session.id}`,workflowRunId:crypto.randomUUID(),dispatchId:crypto.randomUUID(),attemptId,trigger:{kind:"next"}});if(claim.action!=="claimed")throw Error("claim");
  const identity={...original.identity,sessionId:session.id,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID()};
  const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);return await persistModelCallSourceReceipt(app.db,identity,{input:rows.map(row=>row.item)});
 };
 const parentText=typeof parent.item.content==="string"?parent.item.content:(parent.item.content as {text:string}[]).map(part=>part.text).join("\n");
 const context=`${IMPORTED_HISTORY_CONTEXT_HEADER}\n${parent.item.role}: ${parentText}`;
 expect((await createImported([null],context)).complete).toBe(false);
 expect((await createImported([source],context.slice(0,-1))).complete).toBe(false);
 const exact=await createImported([source],context);expect(exact.complete).toBe(true);expect(exact.closure.map(node=>node.sourceRef.id)).toContain(parent.id);
 const foreign=await createImported([{...source,source:"external.fixture"}],context);expect(foreign.complete).toBe(false);expect(foreign.inputs[0]!.parents[0]!.owner).toBe("external.fixture");
});
test("retained source refs survive raw tool-result projection and only enter the next exact call",async()=>{
 const {identity,write}=await fixture();const firstRows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const first=await persistModelCallSourceReceipt(app.db,identity,{input:firstRows.map(row=>row.item)});
 const retained=ModelSourceRef.parse({owner:"fixture.retained_revision",id:crypto.randomUUID(),version:"1",sha256:createHash("sha256").update("Synthetic source").digest("hex")});
 const rawSourceRef={owner:"native.tool.result",id:crypto.randomUUID(),sha256:createHash("sha256").update("Synthetic raw result").digest("hex")};
 const result={type:"function_call_result",callId:"source-call",output:"Synthetic projected result"};
 await appendSessionHistoryItems(app.db,{...write,items:[{position:Math.max(...firstRows.map(row=>row.position))+1,item:result,sourceBasis:{kind:"TOOL_RESULT",parents:[rawSourceRef],retainedSources:[retained],rawToolSource:{sourceCallId:"source-call",nativeModelSourceKey:identity.sourceKey,rawSourceRef,retainedSources:[retained]}}}]});
 const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const next=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:2},{input:rows.map(row=>row.item)});
 expect(next.complete).toBe(true);expect(next.inputs.flatMap(input=>input.retainedSources)).toContainEqual(retained);expect(first.inputs.flatMap(input=>input.retainedSources)).toEqual([]);expect((await readModelCallSourceReceipt(app.db,identity)).receipt!.id).toBe(first.id);
});
test("caps and immutable producer metadata cannot manufacture complete proof",async()=>{
 const {identity}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const oversized=await persistModelCallSourceReceipt(app.db,identity,{input:Array(MODEL_CALL_SOURCE_MAX_INPUTS+1).fill(rows[0]!.item)});expect(oversized.complete).toBe(false);expect(oversized.incompleteReasons).toContain("CAP_EXCEEDED");
 const [privileges]=await shared.admin`select has_table_privilege('opengeni_app','model_call_source_receipts','UPDATE') as update,has_table_privilege('opengeni_app','model_call_source_receipts','DELETE') as delete`;
 expect(privileges!.update).toBe(false);expect(privileges!.delete).toBe(false);
 const guards=await shared.admin`select p.proname,p.proconfig,has_function_privilege('opengeni_app',p.oid,'EXECUTE') as execute from pg_proc p where p.pronamespace=current_schema()::regnamespace and p.proname in ('guard_model_call_source_receipt','guard_history_source_basis_immutable')`;expect(guards).toHaveLength(2);for(const guard of guards){expect(guard.execute).toBe(false);expect(guard.proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);}
 await expect((async()=>await shared.admin`update model_call_source_receipts set digest=digest where id=${oversized.id}`)()).rejects.toThrow("IMMUTABLE");
 await expect((async()=>await shared.admin`update session_history_items set source_basis='{}'::jsonb where id=${rows[0]!.id}`)()).rejects.toThrow("IMMUTABLE");
});

test("installed session copy keeps recursive native parents without borrowing another workspace",async()=>{
 const original=await fixture({managed:true});const {identity}=original;let sourceRows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const compaction=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID()},{purpose:"COMPACTION",instructions:"Copied compaction-only instruction",input:sourceRows.map(row=>row.item),instructionSelections:original.instructionSelections});
 await applyContextCompaction(app.db,{...original.write,replacementItems:[],summaryItem:buildSummaryItem("Copied summary"),summarySourceIds:sourceRows.map(row=>row.id),summaryModelSourceKey:compaction.sourceKey});
 sourceRows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const source=await readFile(new URL("../../../packages/db/src/session-tenancy.ts",import.meta.url),"utf8");const version=Number(source.match(/const SESSION_TENANCY_ACTIVATION_VERSION = (\d+)/)?.[1]);if(!Number.isInteger(version))throw Error("activation source drift");
 await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${identity.accountId},${version},${createHash("sha256").update("native-copy-fixture").digest("hex")},${createHash("sha256").update("native-copy-fixture-parity").digest("hex")},'database-test')`;
 const settlement=await applySessionTurnSettlement(app.db,identity.workspaceId,{sessionId:identity.sessionId,turnId:identity.turnId,triggerEventId:original.triggerEventId,attemptId:identity.attemptId,turnStatus:"completed",sessionStatus:"idle",activeTurnId:null,events:[{type:"turn.completed",payload:{output:"Synthetic response"}}]});expect(settlement.action).toBe("settled");
 const fork=await forkSessionContent(app.db,{sourceWorkspaceId:identity.workspaceId,sourceSessionId:identity.sessionId,actorSubjectId:original.subjectId,destinationWorkspaceId:identity.workspaceId,destinationVisibility:"workspace_shared",workspaceSharedAcknowledged:true,operationKey:crypto.randomUUID()});
 const originalHistory=await shared.admin`select id from session_history_items where session_id=${identity.sessionId} order by position`;
 const copied=await shared.admin`select source_basis,active from session_history_items where session_id=${fork.sessionId} order by position`;expect(copied).toHaveLength(originalHistory.length);expect(copied.find(row=>row.active)!.source_basis.parents[0].id).toBe(sourceRows[0]!.id);
 await initializeSessionStartAtomically(app.db,{accountId:identity.accountId,workspaceId:identity.workspaceId,sessionId:fork.sessionId,reasoningEffortFallback:"low",createdEventPayload:{}});
 const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,identity.workspaceId,{sessionId:fork.sessionId,workflowId:`session-${fork.sessionId}`,workflowRunId:crypto.randomUUID(),dispatchId:crypto.randomUUID(),attemptId,trigger:{kind:"next"}});if(claim.action!=="claimed")throw Error("claim");
 const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,fork.sessionId);const receipt=await persistModelCallSourceReceipt(app.db,{...identity,sessionId:fork.sessionId,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID()},{input:rows.map(row=>row.item)});expect(receipt.complete).toBe(true);expect(receipt.closure.map(node=>node.sourceRef.id)).toContain(sourceRows[0]!.id);expect(receipt.closure.map(node=>node.sourceRef)).toContainEqual({owner:"model_call_source_receipts",id:compaction.id,sha256:compaction.digest});expect(receipt.closure.flatMap(node=>node.retainedSources)).toContainEqual(compaction.inputs[0]!.retainedSources.find(ref=>ref.owner==="workspace_instruction_policy_snapshots")!);
});

test("portable/remote compaction and title each record their actual ordered source basis",async()=>{
 const {identity}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const input=rows.map(row=>bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]}));
 const requests=[buildCompactionPromptInput(input),buildRemoteCompactionV2PromptInput(input)];
 for(const [index,prepared] of requests.entries()){const receipt=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:index+1},{purpose:"COMPACTION",input:prepared,sourceBindings:modelSourceBindings(prepared)});expect(receipt.complete).toBe(true);expect(receipt.inputs.at(-1)!.sourceRef!.owner).toBe("native.runtime.artifact");expect(receipt.inputs[0]!.sourceRef!.id).toBe(rows[0]!.id);}
 const title=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:3},{purpose:"TITLE",input:"Synthetic request",instructions:"Synthetic title instruction"});expect(title.complete).toBe(true);expect(title.inputs.at(-1)!.parents[0]!.id).toBe(identity.turnId);
});

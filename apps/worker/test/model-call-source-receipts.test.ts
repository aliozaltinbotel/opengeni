import { createTurnHistorySink } from "../src/activities/agent-turn/history-sink";
import { createRuntimeBatcher } from "../src/activities/streaming";
import { normalizeSdkEvent } from "../../../packages/runtime/src/run-events";
import { historyRowsToAppend, pendingToolCallFromSdkEvent, completedToolCallFromSdkEvent } from "../src/activities/agent-turn/history";
import { projectHistoryForProvider } from "../../../packages/runtime/src/provider-history-adapter";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";
import postgres from "postgres";
import { installLazyToolRuntime, LazyToolModelProvider } from "../../../packages/runtime/src/lazy-tool-transport";
import { persistAndAuthorizeModelCallSource } from "../src/activities/agent-turn/run";
import { IMPORTED_HISTORY_CONTEXT_HEADER,MODEL_CALL_SOURCE_MAX_INPUTS, canonicalModelSourceJson, ModelSourceRef } from "@opengeni/contracts";
import { buildSummaryItem, buildCompactionPromptInput, buildRemoteCompactionV2PromptInput } from "@opengeni/runtime";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Agent, tool, Runner, Usage, type ModelRequest, type Model, type StreamEvent, type MCPServer } from "@openai/agents";
import { acquireSharedTestDatabase, ScriptedModel, functionCall, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import { appendSessionEventsForTurnAttempt, listSessionEvents, ensureSessionSkillCatalog, validateRetainedModelSources, submitHumanPromptInTransaction, withWorkspaceSubjectSessionActivityRls, applySessionTurnSettlement, ensureManagedAccessForUser, forkSessionContent, appendSessionHistoryItems, applyContextCompaction, bootstrapWorkspace, claimSessionWorkForAttempt, createDb, createSession, getActiveSessionHistoryItemsPaged, initializeSessionStartAtomically, getOrCreateCompanyProfileSnapshot, getOrCreateWorkspaceInstructionPolicySnapshot, getOrCreatePreferenceRegistrySnapshot, withSessionRlsActorContext, persistModelCallSourceReceipt, readModelCallSourceReceipt, recordModelCallFact, type ModelCallSourceIdentity } from "@opengeni/db";
import { ModelRequestCaptureModel, withModelRequestCapture, bindModelSourceInput, omitModelSourceInputBinding, modelSourceBindings, nativeModelSourceKeyForToolCall, type ModelRequestCapture } from "../../../packages/runtime/src/model-request-capture";
import { toPostgresLosslessJson } from "../../../packages/db/src/lossless-json";
let shared:SharedTestDatabase;
let app:ReturnType<typeof createDb>;
beforeAll(async()=>{const external=process.env.OPENGENI_MODEL_SOURCE_TEST_APP_URL;if(external){const adminUrl=process.env.OPENGENI_MODEL_SOURCE_TEST_ADMIN_URL;if(!adminUrl)throw Error("External source receipt fixture requires its exact admin URL");const admin=postgres(adminUrl,{max:1});shared={appUrl:external,adminUrl,admin,release:async()=>{await admin.end();}};app=createDb(external,{max:4});return;}const acquired=await acquireSharedTestDatabase("model-call-source-receipts");if(!acquired)throw Error("PostgreSQL required");shared=acquired;app=createDb(shared.appUrl,{max:4});},180_000);
afterAll(async()=>{await app?.close();await shared?.release();},60_000);
async function fixture(options:{metadata?:Record<string,unknown>;initialModelContext?:string;initialMessageModelSourceRefs?:import("@opengeni/contracts").ModelSourceRef[];managed?:boolean}={}){
 const suffix=crypto.randomUUID();
 const userId=`native-source-${suffix}`;const subjectId=options.managed?`user:${userId}`:suffix;
 const access=options.managed?await ensureManagedAccessForUser(app.db,{userId,email:`${userId}@example.test`,name:"Synthetic owner"}):await bootstrapWorkspace(app.db,{accountExternalSource:"source-receipt",accountExternalId:suffix,accountName:"Test",workspaceExternalSource:"source-receipt",workspaceExternalId:suffix,workspaceName:"Test",subjectId:suffix});
 const {accountId,workspaceId}=access.workspaceGrants[0]!;if(!workspaceId)throw Error("workspace");
 const session=await createSession(app.db,{accountId,workspaceId,initialMessage:"Synthetic request",...(options.initialMessageModelSourceRefs?{initialMessageModelSourceRefs:options.initialMessageModelSourceRefs}:{}),createdBy:{kind:"subject",subjectId},resources:[],metadata:options.metadata??{},...(options.initialModelContext?{initialModelContext:options.initialModelContext}:{}),model:"scripted",reasoningEffort:"low",latencyMode:"standard",sandboxBackend:"none"});
 await initializeSessionStartAtomically(app.db,{accountId,workspaceId,sessionId:session.id,reasoningEffortFallback:"low",createdEventPayload:{}});
 const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,workspaceId,{sessionId:session.id,workflowId:`session-${session.id}`,workflowRunId:crypto.randomUUID(),dispatchId:suffix,attemptId,trigger:{kind:"next"}});
 if(claim.action!=="claimed")throw Error("claim");
 const identity:ModelCallSourceIdentity={accountId,workspaceId,sessionId:session.id,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID(),requestIndex:1};
 const instructionSelections=await withSessionRlsActorContext({subjectId:"worker:source-receipt",initiatingHumanSubjectId:subjectId},async()=>{const profile=await getOrCreateCompanyProfileSnapshot(app.db,identity);const policy=await getOrCreateWorkspaceInstructionPolicySnapshot(app.db,identity);const preferences=await getOrCreatePreferenceRegistrySnapshot(app.db,identity);return {instructionPolicySnapshotId:policy.id,preferenceSnapshotId:preferences.id,companyProfileSnapshotId:profile.id};});
 return {identity,instructionSelections,subjectId,triggerEventId:claim.turn.triggerEventId,write:{accountId,workspaceId,sessionId:session.id,turnId:claim.turn.id,expectedAttemptId:attemptId,expectedExecutionGeneration:claim.turn.executionGeneration}};
}
function request(input:ModelRequest["input"]|Record<string,unknown>[]):ModelRequest{return {systemInstructions:"Synthetic instruction",input:input as ModelRequest["input"],tools:[],handoffs:[],modelSettings:{},outputType:"text",tracing:false};}
test("persistence removes only native source binding and keeps unknown symbols refused",()=>{
 const json={type:"message",role:"user",content:[{type:"input_text",text:"Synthetic exact bytes"}]};
 const owned=bindModelSourceInput({...json},{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:crypto.randomUUID(),sha256:"a".repeat(64)},parents:[],retainedSources:[]});
 const wire=omitModelSourceInputBinding(owned);expect(wire).toEqual(json);expect(JSON.stringify(wire)).toBe(JSON.stringify(owned));expect(modelSourceBindings([owned])).toHaveLength(1);expect(modelSourceBindings([wire])).toEqual([]);expect(toPostgresLosslessJson(wire)).toEqual(json);
 Object.defineProperty(owned,Symbol("unknown-owner"),{value:"untrusted",enumerable:true});expect(()=>toPostgresLosslessJson(omitModelSourceInputBinding(owned))).toThrow("Canonical JSON cannot contain symbol keys");
 const hidden=bindModelSourceInput({...json},{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:crypto.randomUUID(),sha256:"b".repeat(64)},parents:[],retainedSources:[]});Object.defineProperty(hidden,Symbol("unknown-hidden-owner"),{value:"untrusted",enumerable:false});expect(()=>toPostgresLosslessJson(omitModelSourceInputBinding(hidden))).toThrow("Canonical JSON cannot contain symbol keys");
});

for (const streaming of [false, true]) {
 test(`actual SDK native tool search ${streaming ? "streaming" : "ordinary"} persists exact discovery ancestry before second model call`, async()=>{
  const retained={owner:"cendra.knowledge.retrieval_use",id:crypto.randomUUID(),sha256:createHash("sha256").update("Synthetic selected origin").digest("hex"),version:"1"};
  const f=await fixture({initialMessageModelSourceRefs:[retained]}); const receipts:Awaited<ReturnType<typeof persistModelCallSourceReceipt>>[]=[];
  const selected=tool({name:"fixture__procedure_draft",description:"Create a synthetic procedure draft",parameters:{type:"object",properties:{},required:[],additionalProperties:false},strict:true,execute:()=>"unused"});
  const agent=new Agent({name:"source-search",model:"scripted",instructions:"Search the available tools.",tools:[selected]});
  const runtime=installLazyToolRuntime(agent,"openai_native",new Set(["fixture"]));
  let calls=0;let continuation:ModelRequest|undefined;
  const step=()=>++calls===1 ? {output:[{type:"tool_search_call" as const,call_id:"source-search-call",execution:"client" as const,status:"completed" as const,arguments:{query:"",names:[selected.name]}}]} : {outputText:"Synthetic completed discovery"};
  const model:Model={async getResponse(sent){return new ScriptedModel([step()]).getResponse(sent);},async *getStreamedResponse(sent){yield*new ScriptedModel([step()]).getStreamedResponse(sent);}};
  const capture:ModelRequestCapture=()=>{};
  capture.beforeCall=async sent=>{
   const receipt=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:receipts.length+1},{instructions:sent.systemInstructions,tools:sent.tools,input:sent.input,sourceBindings:modelSourceBindings(sent.input),instructionSelections:f.instructionSelections});
   receipts.push(receipt);continuation=sent;
   expect(receipt.incompleteReasons).toEqual([]);expect(receipt.complete).toBe(true);
   for(const item of sent.input)if(typeof item==="object" && item.type==="tool_search_output"){
    const binding=modelSourceBindings([item])[0]!;
    const discoveryInput=receipt.inputs.find(input=>input.contentSha256===binding.sourceRef.sha256)!;
    expect(discoveryInput.kind).toBe("TOOL_RESULT");
    expect(receipt.closure.find(node=>node.sourceRef.id===discoveryInput.sourceRef!.id)?.kind).toBe("TOOL_RESULT");
   }
   return receipt.sourceKey;
  };
  const rows=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
  for(const row of rows)bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]});
  const settings=testSettings({sandboxBackend:"none",webSearchEnabled:false});
  let result:Awaited<ReturnType<Runner["run"]>>|undefined;
  const sink=createTurnHistorySink({db:app.db,accountId:f.identity.accountId,workspaceId:f.identity.workspaceId,sessionId:f.identity.sessionId,attemptId:f.identity.attemptId,
   getTurnId:()=>f.identity.turnId,getExecutionGeneration:()=>f.identity.executionGeneration,getStream:()=>result,getModelRunSettings:()=>settings,
   media:{retainNativeGeneratedImagesFromHistory:async()=>{},retainedScreenshotReceiptsByCallId:new Map(),generatedImageReceiptsByProviderItemId:new Map()},
  } as unknown as Parameters<typeof createTurnHistorySink>[0]);
  const input=rows.map(row=>row.item) as ModelRequest["input"];
  sink.seedHistory(input,rows.length);sink.nextHistoryPosition=Math.max(...rows.map(row=>row.position))+1;
  capture.callCompleted=(_key,_id,_response,restore)=>{sink.recordModelSourceRestorer(restore);};
  capture.onModelToolSource=async source=>{sink.recordModelToolSource(source);};
  const batcher=createRuntimeBatcher(async events=>{
   const appended=await appendSessionEventsForTurnAttempt(app.db,f.identity.workspaceId,f.identity.sessionId,f.identity.turnId,f.identity.executionGeneration,f.identity.attemptId,events);
   expect(appended.accepted).toBe(true);expect(appended.events).toHaveLength(events.length);
  });
  await withModelRequestCapture(capture,async()=>{
   const runner=new Runner({tracingDisabled:true,modelProvider:new LazyToolModelProvider({getModel:async()=>model},runtime)});
   if(streaming){
    const running=await runner.run(agent,input,{stream:true,historyOwnership:"external"});result=running;
    for await(const event of running){
     if((event.type==="raw_model_stream_event" && event.data.type==="response_done") || (event.type==="run_item_stream_event" && event.item.type==="tool_search_output_item"))await sink.reconcileConversationTruth({requireDurable:true});
     pendingToolCallFromSdkEvent(event);completedToolCallFromSdkEvent(event);
     for(const normalized of normalizeSdkEvent(event))await batcher.push(normalized);
    }
    await running.completed;
   } else {
    result=await runner.run(agent,input,{historyOwnership:"external"});
    // Ordinary Runner exposes the same actual SDK RunItems after completion.
    for(const item of result.newItems){
     const event={type:"run_item_stream_event" as const,name:item.type,item};
     for(const normalized of normalizeSdkEvent(event))await batcher.push(normalized);
    }
   }
   await sink.reconcileConversationTruth({requireDurable:true});await batcher.flush();
  });
  expect(receipts).toHaveLength(2);expect(calls).toBe(2);
  const produced=(continuation!.input as import("@openai/agents").AgentInputItem[]).find(item=>item.type==="tool_search_output")!;
  const basis=modelSourceBindings([produced])[0]!;
  const changed=structuredClone(produced) as Record<string,unknown>;
  (changed.tools as Record<string,unknown>[])[0]!.description="Changed selected schema";
  const changedBinding={...basis,sourceRef:{...basis.sourceRef,sha256:createHash("sha256").update(JSON.stringify(changed)).digest("hex")}};
  const mutations=[{item:changed,binding:changedBinding},
   {item:structuredClone(produced),binding:{...basis,nativeProducerSourceKey:"not-current-producing-call"}},
   {item:structuredClone(produced),binding:{...basis,rawToolSource:{...basis.rawToolSource!,sourceCallId:"other-search-call"}}}];
  for(const [offset,mutation] of mutations.entries()){
   const rejected=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:4+offset},{input:[mutation.item],sourceBindings:[mutation.binding],instructionSelections:f.instructionSelections});
   expect(rejected.complete).toBe(false);expect(rejected.incompleteReasons).toContain("UNRESOLVED_PARENT");
  }
  const saved=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
  const discovery=saved.find(row=>row.item.type==="tool_search_output")!;expect(discovery).toBeDefined();
  const [durable]=await shared.admin`select source_basis from session_history_items where account_id=${f.identity.accountId} and workspace_id=${f.identity.workspaceId} and session_id=${f.identity.sessionId} and id=${discovery.id}`;
  expect(durable!.source_basis.kind).toBe("TOOL_RESULT");expect(durable!.source_basis.rawToolSource.nativeModelSourceKey).toBe(receipts[0]!.sourceKey);
  const events=await listSessionEvents(app.db,f.identity.workspaceId,f.identity.sessionId);
  expect(events.some(event=>event.type==="agent.toolCall.output")).toBe(true);
  // Select only discovery: a transcript without its adjacent call must still
  // retain the exact producing call's current host sources through durable basis.
  const selectedRow=bindModelSourceInput(discovery.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:discovery.id,sha256:discovery.sourceSha256!},parents:[],retainedSources:[]});
  const replay=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:3},{input:[selectedRow],sourceBindings:modelSourceBindings([selectedRow]),instructionSelections:f.instructionSelections});
  expect(replay.incompleteReasons).toEqual([]);expect(replay.complete).toBe(true);
  expect(replay.closure.some(node=>node.sourceRef.owner==="model_call_source_receipts" && node.sourceRef.id===receipts[0]!.id && node.sourceRef.sha256===receipts[0]!.digest)).toBe(true);
  expect(replay.closure.flatMap(node=>node.retainedSources)).toContainEqual(retained);
  const validation=await validateRetainedModelSources(app.db,{identity:{...f.identity,sourceKey:replay.sourceKey,requestIndex:3},receipt:replay});
  expect(validation.sources).toContainEqual({sourceRef:retained,status:"HOST_AUTHORITY_REQUIRED",reason:"HOST_AUTHORITY_REQUIRED"});
  let replayCalls=0;
  const reloadCapture:ModelRequestCapture=()=>{};
  reloadCapture.beforeCall=async sent=>{
   const current=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:7},{input:sent.input,sourceBindings:modelSourceBindings(sent.input),instructionSelections:f.instructionSelections});
   expect(current.incompleteReasons).toEqual([]);expect(current.complete).toBe(true);return current.sourceKey;
  };
  const reloadModel:Model={async getResponse(){replayCalls++;return {usage:new Usage(),output:[]};},async *getStreamedResponse(){replayCalls++;yield {type:"response_done",response:{id:"reloaded",output:[],usage:{inputTokens:0,outputTokens:0,totalTokens:0}}};}};
  await withModelRequestCapture(reloadCapture,async()=>{
   if(streaming){for await(const _ of runtime.wrapModel(reloadModel).getStreamedResponse(request([selectedRow]))){} }
   else await runtime.wrapModel(reloadModel).getResponse(request([selectedRow]));
  });
  expect(replayCalls).toBe(1);
  // The native receipt preserves evidence; it cannot convert host withdrawal
  // into authority or reach a provider after that host refuses the same origin.
  const withdrawn:ModelRequestCapture=()=>{};
  withdrawn.beforeCall=async()=>{expect(replay.closure.flatMap(node=>node.retainedSources)).toContainEqual(retained);throw Error("HOST_SOURCE_WITHDRAWN");};
  await expect(withModelRequestCapture(withdrawn,()=>runtime.wrapModel(model).getResponse(request([selectedRow])))).rejects.toThrow("HOST_SOURCE_WITHDRAWN");
  expect(calls).toBe(2);

 },60_000);
}

for (const streaming of [false, true]) {
test(`actual SDK transient ${streaming ? "streaming" : "ordinary"} long continuations retain distinct exact sources and refuse source mutants`,async()=>{
 const {buildOpenGeniAgent,prepareAgentTools}=await import("@opengeni/runtime");
 const f=await fixture();let index=0,calls=0;
 const raw={content:[{type:"text" as const,text:"Synthetic exact evidence"}],structuredContent:{passage:"Synthetic exact evidence"}};
 const retained={owner:"cendra.knowledge.retrieval_use",id:crypto.randomUUID(),version:"1",sha256:createHash("sha256").update("Synthetic exact evidence").digest("hex")};
 // Derive identity coverage from the released schema, including same-id variants.
 // The versionless wire identity omits its optional key; an own undefined value is not durable JSON.
 const distinctRetained=[retained,...Object.keys(ModelSourceRef.shape).map(field=>ModelSourceRef.parse({
  ...retained,[field]:field==="sha256"?createHash("sha256").update("Synthetic distinct digest").digest("hex"):`${retained[field as keyof typeof retained]}:distinct`,
 })),ModelSourceRef.parse(Object.fromEntries(Object.entries(retained).filter(([field])=>field!=="version")))];
 const toolSteps=16;
 const settings=testSettings({sandboxBackend:"none",webSearchEnabled:false,mcpServers:[{id:"cendra-pms",url:"https://synthetic.invalid/mcp",cacheToolsList:false}]});
 const prepared=await prepareAgentTools(settings,[{kind:"mcp",id:"cendra-pms"}],{...f.identity,localMcpServers:[{id:"cendra-pms",server:{
  name:"cendra-pms",cacheToolsList:false,connect:async()=>{},close:async()=>{},invalidateToolsCache:async()=>{},
  listTools:async()=>[{name:"knowledge_search",inputSchema:{type:"object",properties:{},required:[],additionalProperties:false}}],
  callTool:async()=>raw.content,callToolResult:async()=>raw,
 } satisfies MCPServer,modelSourceRefs:()=>distinctRetained}]});
 const receipts:Awaited<ReturnType<typeof persistModelCallSourceReceipt>>[]=[];
 let continuation:ModelRequest|undefined;
 const capture:ModelRequestCapture=()=>{};
 capture.beforeCall=async sent=>{
  const receipt=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:++index},
   {instructions:sent.systemInstructions,tools:sent.tools,input:sent.input,sourceBindings:modelSourceBindings(sent.input),instructionSelections:f.instructionSelections});
  expect(receipt.complete).toBe(true);expect(receipt.incompleteReasons).toEqual([]);
  expect((await readModelCallSourceReceipt(app.db,{...f.identity,sourceKey:receipt.sourceKey})).receipt).toEqual(receipt);
  receipts.push(receipt);continuation=sent;return receipt.sourceKey;
 };
 const step=(sent:ModelRequest)=>{
  calls++;
  if(calls>toolSteps)return {outputText:"Synthetic grounded answer"};
  const tool=sent.tools.find(value=>value.type==="function" && value.name.endsWith("__knowledge_search"));
  if(!tool || tool.type!=="function")throw Error("Actual SDK MCP catalog tool missing");
  return {output:[functionCall(tool.name,{},crypto.randomUUID())]};
 };
 const model=new ModelRequestCaptureModel({async getResponse(sent){return await new ScriptedModel([step(sent)]).getResponse(sent);},async *getStreamedResponse(sent){yield* new ScriptedModel([step(sent)]).getStreamedResponse(sent);}});
 try {
  const rows=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
  for(const row of rows)bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]});
  const agent=buildOpenGeniAgent(settings,[],{mcpServers:prepared.mcpServers}).clone({model});
  await withModelRequestCapture(capture,async()=>{
   const runner=new Runner({tracingDisabled:true}),input=rows.map(row=>row.item) as ModelRequest["input"];
   if(streaming){
    let stream: Awaited<ReturnType<typeof runner.run>> | undefined;
    const sink=createTurnHistorySink({db:app.db,accountId:f.identity.accountId,workspaceId:f.identity.workspaceId,sessionId:f.identity.sessionId,attemptId:f.identity.attemptId,
     getTurnId:()=>f.identity.turnId,getExecutionGeneration:()=>f.identity.executionGeneration,getStream:()=>stream,getModelRunSettings:()=>settings,
     media:{retainNativeGeneratedImagesFromHistory:async()=>{},retainedScreenshotReceiptsByCallId:new Map(),generatedImageReceiptsByProviderItemId:new Map()},
    } as unknown as Parameters<typeof createTurnHistorySink>[0]);
    sink.seedHistory(input,rows.length);sink.nextHistoryPosition=Math.max(...rows.map(row=>row.position))+1;
    let restore:((items:readonly unknown[])=>void)|undefined;
    capture.callCompleted=(_key,_id,_response,current)=>{restore=current;sink.recordModelSourceRestorer(current);};
    capture.onModelToolSource=async source=>{sink.recordModelToolSource(source);};
    const batcher=createRuntimeBatcher(async events=>{
     const appended=await appendSessionEventsForTurnAttempt(app.db,f.identity.workspaceId,f.identity.sessionId,f.identity.turnId,f.identity.executionGeneration,f.identity.attemptId,events);
     expect(appended.accepted).toBe(true);expect(appended.events).toHaveLength(events.length);
    });
    const running=await runner.run(agent,input,{stream:true,historyOwnership:"external",maxTurns:toolSteps+1});stream=running;
    for await(const event of running){
     // Match worker ordering: reconcile completed model/tool history before event projection.
     if ((event.type === "raw_model_stream_event" && event.data.type === "response_done")
       || (event.type === "run_item_stream_event" && event.item.type === "tool_call_output_item")) {
      await sink.reconcileConversationTruth({requireDurable:true});
     }
     // Exercise the source-bound SDK object that terminal reconciliation/continuation can expose.
     if(event.type==="run_item_stream_event")restore?.([event.item.rawItem]);
     pendingToolCallFromSdkEvent(event);completedToolCallFromSdkEvent(event);
     for(const normalized of normalizeSdkEvent(event))await batcher.push(normalized);
    }
    await running.completed;await batcher.flush();
    await sink.reconcileConversationTruth({requireDurable:true});
    const saved=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
    expect(saved.filter(row=>row.item.type==="function_call")).toHaveLength(toolSteps);
    const answer=saved.find(row=>row.item.role==="assistant")!;
    const [answerSource]=await shared.admin`select source_basis from session_history_items where account_id=${f.identity.accountId} and workspace_id=${f.identity.workspaceId} and session_id=${f.identity.sessionId} and id=${answer.id}`;
    expect(answerSource!.source_basis).toEqual({kind:"HISTORY_ROW",parents:[{owner:"model_call_source_receipts",id:receipts.at(-1)!.id,sha256:receipts.at(-1)!.digest}]});
    const events=await listSessionEvents(app.db,f.identity.workspaceId,f.identity.sessionId);
    expect(events.filter(event=>event.type==="agent.toolCall.created")).toHaveLength(toolSteps);
    expect(events.filter(event=>event.type==="agent.toolCall.output")).toHaveLength(toolSteps);
    expect(events.filter(event=>event.type==="agent.message.completed")).toHaveLength(1);
    for(const event of events)expect(()=>toPostgresLosslessJson(event.payload)).not.toThrow();
   }
   else await runner.run(agent,input,{historyOwnership:"external",maxTurns:toolSteps+1});
  });
  expect(calls).toBe(toolSteps+1);expect(receipts).toHaveLength(toolSteps+1);
  for(const receipt of receipts){
   for(const node of [...receipt.inputs,...receipt.closure]){
    expect(node.retainedSources.map(canonicalModelSourceJson)).toEqual([...new Set(node.retainedSources.map(canonicalModelSourceJson))]);
   }
  }
  for(const source of distinctRetained)expect(receipts.at(-1)!.inputs.flatMap(item=>item.retainedSources)).toContainEqual(source);
  expect(receipts[0]!.inputs.flatMap(item=>item.retainedSources)).not.toContainEqual(retained);
  expect(receipts[2]!.inputs.flatMap(item=>item.retainedSources)).toContainEqual(retained);
  if(!continuation || !Array.isArray(continuation.input))throw Error("Actual SDK continuation absent");
  const actualInput=continuation.input,actualBindings=modelSourceBindings(actualInput);
  const resultBinding=actualBindings.find(binding=>binding.rawToolSource)!;
  expect(resultBinding.sourceRef.sha256).not.toBe(resultBinding.rawToolSource!.rawSourceRef.sha256);
  expect(resultBinding.rawToolSource!.rawSourceRef.sha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  const foreign=await fixture();
  const foreignRows=await getActiveSessionHistoryItemsPaged(app.db,foreign.identity.workspaceId,foreign.identity.sessionId);
  const foreignReceipt=await persistModelCallSourceReceipt(app.db,foreign.identity,{input:foreignRows.map(row=>row.item)});
  const title=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:++index},{purpose:"TITLE",input:"Synthetic request"});
  const mutants:((bindings:typeof actualBindings,input:typeof actualInput)=>void)[]=[
   bindings=>{bindings.splice(bindings.findIndex(binding=>binding.rawToolSource),1);},
   bindings=>{delete bindings.find(binding=>binding.rawToolSource)!.nativeProducerSourceKey;},
   bindings=>{delete bindings.find(binding=>binding.rawToolSource)!.rawToolSource;},
   bindings=>{bindings.find(binding=>binding.rawToolSource)!.rawToolResult={content:[{type:"text",text:"Altered raw source"}]};},
   bindings=>{const binding=bindings.find(value=>value.rawToolSource)!;binding.rawToolSource!.rawSourceRef.sha256="f".repeat(64);binding.parents=[binding.rawToolSource!.rawSourceRef];},
   bindings=>{const binding=bindings.find(value=>value.rawToolSource)!;binding.nativeProducerSourceKey=foreignReceipt.sourceKey;binding.rawToolSource!.nativeModelSourceKey=foreignReceipt.sourceKey;},
   bindings=>{const binding=bindings.find(value=>value.rawToolSource)!;binding.nativeProducerSourceKey=title.sourceKey;binding.rawToolSource!.nativeModelSourceKey=title.sourceKey;},
   (bindings,input)=>{const binding=bindings.find(value=>value.rawToolSource)!;(input[binding.ordinal] as {output:unknown}).output="Altered projected source";},
   ...Object.keys(ModelSourceRef.shape).map(field=>(bindings:typeof actualBindings)=>{
    const binding=bindings.find(value=>value.rawToolSource)!;
    const forged=ModelSourceRef.parse({...retained,[field]:field==="sha256"?"f".repeat(64):`${retained[field as keyof typeof retained]}:forged`});
    binding.retainedSources=[...binding.retainedSources,forged];
   }),
  ];
  for(const mutate of mutants){
   const bindings=structuredClone(actualBindings),mutantInput=structuredClone(actualInput);mutate(bindings,mutantInput);
   const refused=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:++index},{input:mutantInput,sourceBindings:bindings});
   expect(refused.complete).toBe(false);expect(refused.incompleteReasons.length).toBeGreaterThan(0);
   // An inconsistent full identity must remain visible in refused evidence.
   const retainedEvidence=new Set(refused.inputs.flatMap(input=>input.retainedSources).map(canonicalModelSourceJson));
   expect(bindings.flatMap(binding=>binding.retainedSources).map(canonicalModelSourceJson).filter(ref=>!retainedEvidence.has(ref))).toEqual([]);
  }
  // Erasing the owning row in this disposable fixture must not be hidden by a
  // previously authenticated receipt graph. Fault injection touches our row only.
  await shared.admin.begin(async tx=>{
   await tx`set local session_replication_role=replica`;
   await tx`delete from session_history_items where id=${rows[0]!.id} and account_id=${f.identity.accountId} and workspace_id=${f.identity.workspaceId}`;
  });
  const erased=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:++index},{input:actualInput,sourceBindings:actualBindings});
  expect(erased.complete).toBe(false);expect(erased.incompleteReasons).toContain("UNRESOLVED_PARENT");
  await expect(persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:++index,executionGeneration:f.identity.executionGeneration+1},{input:actualInput,sourceBindings:actualBindings})).rejects.toThrow();
  expect(calls).toBe(toolSteps+1);
 } finally {await prepared.close();}
},60_000);
}
test("real PostgreSQL commits exact-call proof before dispatch; persistence failure prevents dispatch",async()=>{
 const {identity,instructionSelections}=await fixture();const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);let calls=0;
 const model:Model={async getResponse(){calls++;const stored=await readModelCallSourceReceipt(app.db,identity);expect(stored.receipt?.sourceKey).toBe(identity.sourceKey);expect(stored.receipt?.complete).toBe(true);expect(stored.receipt?.inputs.flatMap(item=>item.retainedSources).some(ref=>ref.owner==="workspace_instruction_policy_snapshots" && ref.id===instructionSelections.instructionPolicySnapshotId)).toBe(true);return {usage:new Usage(),output:[],responseId:"provider-1"};},getStreamedResponse():AsyncIterable<StreamEvent>{throw Error("unused");}};
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
 const inner:Model={async getResponse(){return {usage:new Usage(),responseId:`response-${index}`,output:[{type:"function_call",name:"synthetic",arguments:"{}",callId:`call-${index}`}]}},getStreamedResponse():AsyncIterable<StreamEvent>{throw Error("unused");}};
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


test("host admission is awaited after exact durable receipt and refuses every model purpose before dispatch", async () => {
  const { identity } = await fixture();
  const rows = await getActiveSessionHistoryItemsPaged(app.db, identity.workspaceId, identity.sessionId);
  for (const purpose of ["AGENT", "COMPACTION", "TITLE"] as const) {
    let dispatched = false;
    const sourceKey = crypto.randomUUID();
    const refusal = new Error(`HOST_SOURCE_REFUSED_${purpose}`);
    const attempt = persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey }, { purpose, input: purpose === "TITLE" ? "Synthetic request" : rows.map(row => row.item) }, async receipt => {
      expect(receipt.sourceKey).toBe(sourceKey); expect(receipt.purpose).toBe(purpose);
      expect((await readModelCallSourceReceipt(app.db, { ...identity, sourceKey })).receipt).toEqual(receipt);
      throw refusal;
    }).then(() => { dispatched = true; });
    await expect(attempt).rejects.toBe(refusal);
    expect(dispatched).toBe(false);
  }
});


test("host admission never reuses a prior call and stops cancelled, timed-out or stale work", async () => {
  const { identity } = await fixture();
  const rows = await getActiveSessionHistoryItemsPaged(app.db, identity.workspaceId, identity.sessionId);
  const nativeRequest = { input: rows.map(row => row.item) };
  const observed: string[] = [];
  for (let requestIndex = 1; requestIndex <= 2; requestIndex++) {
    const sourceKey = crypto.randomUUID();
    expect(await persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey, requestIndex }, nativeRequest, async receipt => { observed.push(receipt.sourceKey); })).toBe(sourceKey);
  }
  expect(new Set(observed).size).toBe(2);
  let release!: () => void;
  let entered!: () => void;
  const pendingGuard = new Promise<void>(resolve => { release = resolve; });
  const guardEntered = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  let dispatched = false;
  const sourceKey = crypto.randomUUID();
  const pending = persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey }, nativeRequest, async (receipt, context) => {
    expect(receipt.sourceKey).toBe(sourceKey); expect(context.signal).toBe(controller.signal);
    entered(); await pendingGuard;
  }, controller.signal).then(() => { dispatched = true; });
  await guardEntered; controller.abort(new Error("HOST_ADMISSION_DEADLINE"));
  await expect(pending).rejects.toThrow("Turn operation was cancelled");
  release(); await Promise.resolve(); expect(dispatched).toBe(false);
  let called = false;
  await expect(persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey: crypto.randomUUID(), executionGeneration: identity.executionGeneration + 1 }, nativeRequest, async () => { called = true; })).rejects.toThrow();
  expect(called).toBe(false);
  const before = new AbortController(); before.abort();
  await expect(persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey: crypto.randomUUID() }, nativeRequest, async () => { called = true; }, before.signal)).rejects.toThrow("Turn operation was cancelled");
  expect(called).toBe(false);
  const timeout = new Error("HOST_SOURCE_ADMISSION_TIMEOUT");
  await expect(persistAndAuthorizeModelCallSource(app.db, { ...identity, sourceKey: crypto.randomUUID() }, nativeRequest, async () => { throw timeout; })).rejects.toBe(timeout);
});

test("durable prefix excludes only native source ownership and preserves content and unknown-symbol fences", () => {
  const canonical = {type: "message", role: "user", content: "Synthetic exact durable prefix"};
  const bound = bindModelSourceInput({...canonical}, {kind: "HISTORY_ROW", sourceRef: {owner: "session_history_items", id: crypto.randomUUID(), sha256: "a".repeat(64)}, parents: [], retainedSources: []});
  const guard = new HistoryPrefixGuard();
  guard.seed([canonical], 1);
  const keys = guard.verify([canonical]);
  expect(guard.verify([bound])).toEqual(keys);
  expect(modelSourceBindings([bound])).toHaveLength(1);
  expect(() => guard.verify([{...bound, content: "changed"}])).toThrow("durable prefix changed");
  Object.defineProperty(bound, Symbol("unknown-hidden-owner"), {value: "untrusted", enumerable: false});
  expect(() => guard.verify([bound])).toThrow("cannot contain symbol keys");
});


test("Responses developer projection retains its exact durable source and passes the history prefix guard", async () => {
 const {identity,write}=await fixture();
 const initial=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 await appendSessionHistoryItems(app.db,{...write,items:[{position:Math.max(...initial.map(row=>row.position))+1,item:{type:"message",role:"developer",content:"Synthetic reviewed developer instructions"}}]});
 const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const owned=rows.map(row=>bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]}));
 const projected=projectHistoryForProvider(owned,"responses");
 const guard=new HistoryPrefixGuard();guard.seed(projected,projected.length);expect(()=>guard.verify(projected)).not.toThrow();
 const receipt=await persistModelCallSourceReceipt(app.db,identity,{input:projected,sourceBindings:modelSourceBindings(projected)});
 expect(receipt.complete).toBe(true);expect(receipt.incompleteReasons).toEqual([]);
 const developer=rows.find(row=>row.item.role==="developer")!;
 expect(receipt.inputs.find(item=>item.sourceRef?.id===developer.id)?.sourceRef).toMatchObject({owner:"session_history_items",id:developer.id,sha256:developer.sourceSha256});
 // Without the exact owner's binding, the wrapped bytes cannot borrow a source.
 const missing=await persistModelCallSourceReceipt(app.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:2},{input:projected.map(omitModelSourceInputBinding)});
 expect(missing.complete).toBe(false);
},180_000);


test("actual SDK source-bound output persists and reloads into the next admitted turn", async () => {
 const f=await fixture();let identity=f.identity,write=f.write,triggerEventId=f.triggerEventId;
 const initial=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const sourceBasis={kind:"INSTRUCTION" as const,parents:[{owner:"session_history_items",id:initial[0]!.id,sha256:initial[0]!.sourceSha256!}],retainedSources:[]};
 await appendSessionHistoryItems(app.db,{...write,items:[{position:Math.max(...initial.map(row=>row.position))+1,item:{type:"message",role:"developer",content:"Synthetic durable instructions"},sourceBasis}]});
 const {Agent}=await import("@openai/agents");const counts:number[]=[];
 for(let turn=0;turn<2;turn++) {
  const stored=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
  const bound=stored.map(row=>bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]}));
  const input=projectHistoryForProvider(bound,"responses"),guard=new HistoryPrefixGuard();guard.seed(input,input.length);
  const capture:ModelRequestCapture=()=>{};
  capture.beforeCall=async request=>{const receipt=await persistModelCallSourceReceipt(app.db,identity,{input:request.input,sourceBindings:modelSourceBindings(request.input)});expect(receipt.incompleteReasons).toEqual([]);expect(receipt.complete).toBe(true);return receipt.sourceKey;};
  const result=await withModelRequestCapture(capture,()=>new Runner({tracingDisabled:true}).run(new Agent({name:"source persistence test",model:new ModelRequestCaptureModel(new ScriptedModel([{outputText:`Synthetic answer ${turn}`}]))}),input as ModelRequest["input"],{historyOwnership:"external"}));
  const history=result.history as Array<Record<string,unknown>>;
  expect(()=>guard.verify(history)).not.toThrow();
  const appended=historyRowsToAppend(history,input.length,Math.max(...stored.map(row=>row.position))+1);
  expect(appended.rows.length).toBeGreaterThan(0);
  expect(await appendSessionHistoryItems(app.db,{...write,items:appended.rows})).toBe(true);
  const reloaded=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);counts.push(reloaded.length);
  expect(reloaded.slice(0,stored.length).map(row=>omitModelSourceInputBinding(row.item))).toEqual(stored.map(row=>omitModelSourceInputBinding(row.item)));
  expect(reloaded.some(row=>row.item.role==="assistant")).toBe(true);
  const basis=await shared.admin`select source_basis from session_history_items where session_id=${identity.sessionId} and item->>'role'='developer'`;expect(basis[0]!.source_basis).toEqual(sourceBasis);
  const foreign={...history.at(-1)!,[Symbol("foreign")]:true};
  expect(()=>historyRowsToAppend([foreign],0)).toThrow("cannot contain symbol keys");
  expect((await applySessionTurnSettlement(app.db,identity.workspaceId,{sessionId:identity.sessionId,turnId:identity.turnId,triggerEventId,attemptId:identity.attemptId,turnStatus:"completed",sessionStatus:"idle",activeTurnId:null,events:[{type:"turn.completed",payload:{}}]})).action).toBe("settled");
  if(turn===0){
   await withWorkspaceSubjectSessionActivityRls(app.db,identity.workspaceId,f.subjectId,db=>submitHumanPromptInTransaction(db,{accountId:identity.accountId,workspaceId:identity.workspaceId,sessionId:identity.sessionId,subjectId:f.subjectId,actor:{type:"human",subjectId:f.subjectId},operationKey:crypto.randomUUID(),delivery:"send",text:"Synthetic next question",modelContext:null,resources:[],reasoningEffort:"low",reasoningEffortFallback:"low",source:"user"}));
   const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,identity.workspaceId,{sessionId:identity.sessionId,workflowId:`session-${identity.sessionId}`,workflowRunId:crypto.randomUUID(),attemptId,dispatchId:crypto.randomUUID(),trigger:{kind:"next"}});if(claim.action!=="claimed")throw Error("next claim");
   identity={...identity,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID(),requestIndex:1};write={...write,turnId:identity.turnId,expectedAttemptId:attemptId,expectedExecutionGeneration:identity.executionGeneration};triggerEventId=claim.turn.triggerEventId;
  }
 }
 expect(counts[1]!).toBeGreaterThan(counts[0]!);
},180_000);


test.each([false,true])("selective import of an actual SDK response retains its exact producing Skill call and reaches current host refusal; streaming %s", async (streaming) => {
 const f=await fixture();const {identity,write}=f;
 const skill={owner:"cendra.skill.reviewed_release",id:crypto.randomUUID(),sha256:createHash("sha256").update("Synthetic reviewed Skill").digest("hex"),version:"1"};
 await ensureSessionSkillCatalog(app.db,{...write,catalog:'## Skills\n- {"id":"synthetic","name":"Synthetic","description":"Reviewed instructions"}',retainedSources:[skill]});
 const rows=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);
 const input=projectHistoryForProvider(rows.map(row=>bindModelSourceInput(row.item,{kind:"HISTORY_ROW",sourceRef:{owner:"session_history_items",id:row.id,sha256:row.sourceSha256!},parents:[],retainedSources:[]})),"responses");
 const capture:ModelRequestCapture=()=>{};let sourceReceipt:Awaited<ReturnType<typeof persistModelCallSourceReceipt>>|undefined;
 capture.beforeCall=async request=>{sourceReceipt=await persistModelCallSourceReceipt(app.db,identity,{input:request.input,sourceBindings:modelSourceBindings(request.input)});expect(sourceReceipt.complete).toBe(true);return sourceReceipt.sourceKey;};
 let restoreHistorySources:((items:readonly unknown[])=>void)|undefined;
 capture.callCompleted=(_sourceKey,_responseId,_response,restore)=>{restoreHistorySources=restore;};
 const {Agent}=await import("@openai/agents");
 const result=await withModelRequestCapture(capture,async()=>{
  const runner=new Runner({tracingDisabled:true}),agent=new Agent({name:"Skill-informed output",model:new ModelRequestCaptureModel(new ScriptedModel([{outputText:"Synthetic Skill-informed answer"}]))});
  if(streaming){const stream=await runner.run(agent,input as ModelRequest["input"],{stream:true,historyOwnership:"external"});for await(const _event of stream){}await stream.completed;return stream;}
  return runner.run(agent,input as ModelRequest["input"],{historyOwnership:"external"});
 });
 const sink=createTurnHistorySink({db:app.db,accountId:identity.accountId,workspaceId:identity.workspaceId,sessionId:identity.sessionId,attemptId:identity.attemptId,
  getTurnId:()=>identity.turnId,getExecutionGeneration:()=>identity.executionGeneration,getStream:()=>({state:{history:result.history}}),getModelRunSettings:()=>testSettings({sandboxBackend:"none"}),
  media:{retainNativeGeneratedImagesFromHistory:async()=>{},retainedScreenshotReceiptsByCallId:new Map(),generatedImageReceiptsByProviderItemId:new Map()},
 } as unknown as Parameters<typeof createTurnHistorySink>[0]);
 expect(restoreHistorySources).toBeDefined();sink.recordModelSourceRestorer(restoreHistorySources!);
 sink.seedHistory(input,input.length);sink.nextHistoryPosition=Math.max(...rows.map(row=>row.position))+1;
 await sink.reconcileConversationTruth({requireDurable:true});
 const saved=await getActiveSessionHistoryItemsPaged(app.db,identity.workspaceId,identity.sessionId);const answer=saved.find(row=>row.item.role==="assistant")!;
 const body=typeof answer.item.content==="string"?answer.item.content:(answer.item.content as {text:string}[]).map(part=>part.text).join("\n");
 const imported=await createSession(app.db,{accountId:identity.accountId,workspaceId:identity.workspaceId,initialMessage:"Continue only this imported answer",initialModelContext:`${IMPORTED_HISTORY_CONTEXT_HEADER}\nassistant: ${body}`,createdBy:{kind:"subject",subjectId:f.subjectId},resources:[],metadata:{nativeImportedHistoryOrigins:[{source:"session_history_items",externalId:answer.id,sha256:answer.sourceSha256!}]},model:"scripted",reasoningEffort:"low",latencyMode:"standard",sandboxBackend:"none"});
 await initializeSessionStartAtomically(app.db,{accountId:identity.accountId,workspaceId:identity.workspaceId,sessionId:imported.id,reasoningEffortFallback:"low",createdEventPayload:{}});
 const attemptId=crypto.randomUUID();const claim=await claimSessionWorkForAttempt(app.db,identity.workspaceId,{sessionId:imported.id,workflowId:`session-${imported.id}`,workflowRunId:crypto.randomUUID(),dispatchId:crypto.randomUUID(),attemptId,trigger:{kind:"next"}});if(claim.action!=="claimed")throw Error("import claim");
 const next={...identity,sessionId:imported.id,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID()};
 const importedRows=await getActiveSessionHistoryItemsPaged(app.db,next.workspaceId,next.sessionId);
 const receipt=await persistModelCallSourceReceipt(app.db,next,{input:importedRows.map(row=>row.item)});
 expect(receipt.complete).toBe(true);
 expect(receipt.closure.flatMap(node=>node.retainedSources)).toContainEqual(skill);
 expect(receipt.closure.map(node=>node.sourceRef)).toContainEqual({owner:"model_call_source_receipts",id:sourceReceipt!.id,sha256:sourceReceipt!.digest});
 const native=await validateRetainedModelSources(app.db,{identity:next,receipt});
 expect(native.sources).toContainEqual({sourceRef:skill,status:"HOST_AUTHORITY_REQUIRED",reason:"HOST_AUTHORITY_REQUIRED"});
 // The current host owner withdraws this exact release; no cached earlier admission can dispatch it.
 let dispatched=0,hostChecks=0;const withdrawn=new Set([skill.id]);
 const replay:ModelRequestCapture=()=>{};
 replay.beforeCall=request=>persistAndAuthorizeModelCallSource(app.db,{...next,sourceKey:crypto.randomUUID(),requestIndex:2},{input:request.input},async current=>{hostChecks++;if(current.closure.flatMap(node=>node.retainedSources).some(ref=>ref.owner===skill.owner&&withdrawn.has(ref.id)))throw Error("CURRENT_SKILL_WITHDRAWN");});
 const model=new ModelRequestCaptureModel({async getResponse(request){dispatched++;return new ScriptedModel([{outputText:"must not run"}]).getResponse(request);},async *getStreamedResponse(){throw Error("unused");}});
 await expect(withModelRequestCapture(replay,()=>model.getResponse(request(importedRows.map(row=>row.item))))).rejects.toThrow("CURRENT_SKILL_WITHDRAWN");
 expect(hostChecks).toBe(1);expect(dispatched).toBe(0);
},180_000);


test("model output ancestry refuses foreign calls, wrong purpose, invented basis and source-managed legacy omission", async () => {
 const f=await fixture(),foreign=await fixture();
 const foreignRows=await getActiveSessionHistoryItemsPaged(app.db,foreign.identity.workspaceId,foreign.identity.sessionId);
 await persistModelCallSourceReceipt(app.db,foreign.identity,{input:foreignRows.map(row=>row.item)});
 const rows=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId),position=Math.max(...rows.map(row=>row.position))+1;
 const item={type:"message",role:"assistant",content:"Synthetic generated answer"};
 await expect(appendSessionHistoryItems(app.db,{...f.write,items:[{position,item,nativeProducerSourceKey:foreign.identity.sourceKey}]})).rejects.toThrow("MODEL_OUTPUT_PRODUCER_UNAVAILABLE");
 const compaction=await persistModelCallSourceReceipt(app.db,f.identity,{purpose:"COMPACTION",input:rows.map(row=>row.item)});
 await expect(appendSessionHistoryItems(app.db,{...f.write,items:[{position,item,nativeProducerSourceKey:compaction.sourceKey}]})).rejects.toThrow("MODEL_OUTPUT_PRODUCER_INEXACT");
 await expect(appendSessionHistoryItems(app.db,{...f.write,items:[{position,item,sourceBasis:{kind:"HISTORY_ROW",parents:[{owner:"model_call_source_receipts",id:compaction.id,sha256:compaction.digest}]}}]})).rejects.toThrow("MODEL_OUTPUT_SOURCE_BASIS_REQUIRES_PRODUCER");
 // A legacy unannotated row is retained for transcript reads, but cannot prove model ancestry.
 expect(await appendSessionHistoryItems(app.db,{...f.write,items:[{position,item}]})).toBe(true);
 const legacy=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
 const receipt=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:2},{input:legacy.map(row=>row.item)});
 expect(receipt.complete).toBe(false);expect(receipt.incompleteReasons).toContain("UNRESOLVED_PARENT");
},180_000);


test("live output registry refuses changed bytes and ambiguous producer identities without weakening symbol fences", async () => {
 const output={type:"message" as const,role:"assistant" as const,status:"completed" as const,content:[{type:"output_text" as const,text:"Synthetic exact response"}]};
 const capture:ModelRequestCapture=()=>{};const restorers:Array<(items:readonly unknown[])=>void>=[];
 capture.beforeCall=async()=>crypto.randomUUID();capture.callCompleted=(_key,_id,_response,restore)=>{restorers.push(restore);};
 const model=new ModelRequestCaptureModel(new ScriptedModel([{output:[output]}]));
 await withModelRequestCapture(capture,()=>model.getResponse(request([])));
 const changed={...omitModelSourceInputBinding(output),content:[{type:"output_text",text:"Changed bytes"}]};
 restorers[0]!([changed]);expect(modelSourceBindings([changed])).toEqual([]);
 const foreign=JSON.parse(JSON.stringify(output)) as Record<string,unknown>;Object.defineProperty(foreign,Symbol("foreign"),{value:true,enumerable:false});
 restorers[0]!([foreign]);expect(()=>historyRowsToAppend([foreign],0)).toThrow("cannot contain symbol keys");
 // Two calls produce identical bytes; a symbol-free SDK copy cannot guess which call owns it.
 await withModelRequestCapture(capture,()=>model.getResponse(request([])));
 const ambiguous=JSON.parse(JSON.stringify(output)) as Record<string,unknown>;
 expect(()=>restorers[0]!([ambiguous])).toThrow("MODEL_OUTPUT_SOURCE_AMBIGUOUS");
 expect(modelSourceBindings([ambiguous])).toEqual([]);
});

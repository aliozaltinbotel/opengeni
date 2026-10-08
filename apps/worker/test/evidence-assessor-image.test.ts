import {expect,spyOn,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {MODEL_ATTACHMENT_REFS_FIELD,type FileAsset} from '@opengeni/contracts';
import {createModelHistoryAttachmentProjector} from '../src/activities/run-input';
import {runtimeResourcesForTurn} from '../src/activities/agent-turn/file-resources';
import {historyRowsToAppend} from '../src/activities/agent-turn/history';
const id=(ordinal:number)=>`00000000-0000-4000-8000-${String(ordinal).padStart(12,'0')}`;
const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
const assets:FileAsset[]=[1,2].map(ordinal=>({id:id(ordinal),workspaceId:id(3),status:'ready',filename:'opaque-input',safeFilename:'opaque-input',
 contentType:'image/png',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bucket:'fixture',objectKey:`input/${ordinal}`,
 createdAt:'2026-10-07T00:00:00Z',updatedAt:'2026-10-07T00:00:00Z'}));
const refs=assets.map(file=>({kind:'file' as const,fileId:file.id,asImage:true as const}));
const history=()=>[{type:'message',role:'user',content:'Check the two images.',[MODEL_ATTACHMENT_REFS_FIELD]:refs}];
test('both bound images reach wire in order; original durable input contains references only',async()=>{
 const source=history();const before=JSON.stringify(source);
 const project=createModelHistoryAttachmentProjector({supportsImageInput:true,inputFileMediaTypes:[]},async()=>bytes,async()=>assets);
 const wire=await project(source);const parts=wire[0]!.content as Array<Record<string,unknown>>;
 expect(parts.filter(part=>part.type==='input_image')).toHaveLength(refs.length);
 expect(JSON.stringify(wire)).not.toContain('mountDirectory');
 expect(JSON.stringify(wire)).not.toContain('files__');
 expect(JSON.stringify(wire)).not.toContain('opaque-input');
 expect(JSON.stringify(source)).toBe(before);
 expect(JSON.stringify(historyRowsToAppend([...wire,{type:'message',role:'assistant',content:'{}'}],source.length).rows)).not.toContain('base64');
 expect(runtimeResourcesForTurn(refs,refs)).toEqual([]);
});
test('text-only routing omits pixels explicitly and never reads image bytes',async()=>{
 let reads=0;const wire=await createModelHistoryAttachmentProjector({supportsImageInput:false,inputFileMediaTypes:[]},async()=>{reads++;return bytes;},async()=>assets)(history());
 expect(reads).toBe(0);
 const parts=wire[0]!.content as Array<Record<string,unknown>>;
 expect(parts.filter(part=>part.text==='[Image content omitted because the selected model does not support image input.]')).toHaveLength(refs.length);
 expect(JSON.stringify(wire)).not.toContain('files__');
 expect(JSON.stringify(wire)).not.toContain('base64');
});

// Reuse the production-builder fixture from agent-build-skill-catalog: actual SDK construction, scripted persistence only.
import * as db from '@opengeni/db';
import {createObservability} from '@opengeni/observability';
import {buildOpenGeniAgent,prepareAgentTools} from '@opengeni/runtime';
import {ScriptedModel,testSettings} from '@opengeni/testing';
import {buildTurnAgent,type BuildTurnAgentDeps} from '../src/activities/agent-turn/agent-build';
import {createTurnContext} from '../src/activities/agent-turn/turn-context';
test('the native output bound reaches the actual SDK agent without replacing other model settings',async()=>{
 const settings=testSettings({sandboxBackend:'none',webSearchEnabled:false});
 const prepared=await prepareAgentTools(settings,[]);
 prepared.skillCatalog=[];
 const context=createTurnContext({settings,cancellationRequestedAt:null});context.eventing.preparedTools=prepared;
 const spies=[spyOn(db,'getSandboxRecoveryDiscontinuity').mockResolvedValue(null),
  spyOn(db,'getWorkspaceVideoGenerationPolicy').mockResolvedValue({schemaVersion:1,revision:0,fundingSource:'workspace_gateway',enabledModelIds:[],defaultModelId:null}),
  spyOn(db,'ensureSessionSkillCatalog').mockImplementation(async(_db,value)=>value.catalog),
  spyOn(db,'getExternalLinkTurnAuthorization').mockResolvedValue(null)];
 try{
  const deps:Partial<BuildTurnAgentDeps>={...context,input:{accountId:'account',workspaceId:'workspace',sessionId:'session',attemptId:'attempt',workflowId:'workflow',workflowRunId:'run',trigger:{kind:'next'}},
   db:{} as BuildTurnAgentDeps['db'],runtime:{buildAgent:(configuration,resources,options)=>buildOpenGeniAgent(configuration,resources,{...options,model:new ScriptedModel([])})} as BuildTurnAgentDeps['runtime'],
   observability:createObservability(settings,{component:'worker'}),objectStorage:null,media:{} as BuildTurnAgentDeps['media'],
   turn:{id:'turn',executionGeneration:1,reasoningEffort:'low'} as BuildTurnAgentDeps['turn'],
   session:{id:'session',policyRole:'evidence-assessor',resources:refs,metadata:{nativeMaxOutputTokens:400}} as BuildTurnAgentDeps['session'],runSettings:settings,mcpServers:[],skillCatalog:[],
   turnExecutionPolicy:{providerId:'openai',latencyMode:'standard'} as BuildTurnAgentDeps['turnExecutionPolicy'],runtimeResources:[],sandboxEnvironment:{},
   sandboxArtifactRuntime:{available:false,environment:{}},fileResourceDownloads:[],attemptConnectorActionBindings:[],modelInputPolicy:{inputFileMediaTypes:[],supportsImageInput:true},
   preparationIndependentToolNames:[],groupBoxBackend:'none',postToolPreparationStartedAt:performance.now(),trigger:{type:'user.message',payload:{}} as BuildTurnAgentDeps['trigger']};
  const built=await buildTurnAgent(deps as BuildTurnAgentDeps);
  expect(built.agent.modelSettings.maxTokens).toBe(400);
  expect(built.agent.tools.map(tool=>tool.name)).toEqual([]);
  const ordinary=await buildTurnAgent({...deps,session:{...deps.session,resources:[]}} as BuildTurnAgentDeps);
  expect(ordinary.agent.tools.map(tool=>tool.name)).toContain('request_human_input');
 }finally{for(const spy of spies)spy.mockRestore();await prepared.close();}
});

import {prepareGovernanceAndModel,type GovernanceModelDeps} from '../src/activities/agent-turn/governance-model';
test('admitted image assessment assembles no tenant rules or false selection receipts and retains current authority checks',async()=>{
 const settings=testSettings({sandboxBackend:'none',webSearchEnabled:false});
 const context=createTurnContext({settings,cancellationRequestedAt:null});
 const authority=spyOn(db,'resolveSessionAttemptPersonalResources').mockResolvedValue([]);
 const workspace=spyOn(db,'getWorkspace').mockResolvedValue({id:'workspace',settings:{}} as Awaited<ReturnType<typeof db.getWorkspace>>);
 const policy=spyOn(db,'getWorkspaceModelPolicy').mockResolvedValue(null);
 const selections=[spyOn(db,'getOrCreateCompanyProfileSnapshot'),spyOn(db,'getOrCreateWorkspaceInstructionPolicySnapshot'),
   spyOn(db,'getOrCreatePreferenceRegistrySnapshot'),spyOn(db,'resolveCompanyBrainContextSelection')];
 for(const selection of selections)selection.mockImplementation(async()=>{throw new Error('Tenant instruction selection reached');});
 const other=[spyOn(db,'getSessionAttemptMcpApprovalPolicies').mockResolvedValue({}),spyOn(db,'listSessionMcpServerMetadata').mockResolvedValue([]),
   spyOn(db,'listSessionSystemUpdatesForTurn').mockResolvedValue([])];
 const deps={...context,input:{accountId:'account',workspaceId:'workspace',sessionId:'session',attemptId:'attempt'},db:{},
   runtime:{resolveTurnModel:()=>null},objectStorage:null,media:{},session:{policyRole:'evidence-assessor',resources:refs,rigId:null,rigVersionId:null},
   turn:{id:'turn',executionGeneration:1,sandboxBackend:'none',model:settings.openaiModel,reasoningEffort:'low',initiator:{kind:'subject',subjectId:'assessor'}},
   capabilitySettings:settings,fileAuthoritySubjectId:'assessor',humanInputResume:null,
   turnExecutionPolicy:{providerId:'openai',productModelId:settings.openaiModel,upstreamModelId:settings.openaiModel},requiredGeneratedVideoFiles:[]} as unknown as GovernanceModelDeps;
 try{
  const result=await prepareGovernanceAndModel(deps);expect('ok' in result).toBe(true);
  if(!('ok' in result))throw new Error('Governance assembly exited');
  expect(result.ok.workspaceGovernance).toBeNull();expect(result.ok.workspaceAgentInstructions).toBeNull();expect(result.ok.workspaceMemory).toBeNull();
  expect(result.ok.buildCompanyBrainContributionReceiptFor('')).toBeNull();expect(context.eventing.companyBrainContextContributions).toEqual([]);
  for(const selection of selections)expect(selection).not.toHaveBeenCalled();
  expect(authority).toHaveBeenCalledTimes(1);expect(workspace).toHaveBeenCalledTimes(1);expect(policy).toHaveBeenCalledTimes(1);
  await expect(prepareGovernanceAndModel({...deps,session:{...deps.session,resources:[]}})).rejects.toThrow('Tenant instruction selection reached');
  authority.mockRejectedValueOnce(new Error('Current attempt authority withdrawn'));
  await expect(prepareGovernanceAndModel(deps)).rejects.toThrow('Current attempt authority withdrawn');
 }finally{for(const spy of [authority,workspace,policy,...selections,...other])spy.mockRestore();}
});

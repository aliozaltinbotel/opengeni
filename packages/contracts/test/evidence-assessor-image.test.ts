import { expect, test } from "bun:test";
import { CreateFileUploadRequest, CreateSessionRequest, FileResourceRef, SessionMcpServerInput, GoalSpec, PersonalResourceAttachmentIntent, PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION, UserResourceLifecycleGrantMode } from "../src";
const id = "00000000-0000-4000-8000-000000000001";
test("image opt-in is literal and preserves the immutable output bound", () => {
  expect(FileResourceRef.parse({ kind: "file", fileId: id, asImage: true }).asImage).toBe(true);
  expect(FileResourceRef.safeParse({ kind: "file", fileId: id, asImage: false }).success).toBe(false);
  expect(CreateSessionRequest.parse({ initialMessage: "Inspect the images", maxOutputTokens: 400 }).maxOutputTokens).toBe(400);
  for (const value of [0, -1, 0.5, "400"]) expect(CreateSessionRequest.safeParse({ initialMessage: "Inspect the images", maxOutputTokens: value }).success).toBe(false);
  expect(CreateFileUploadRequest.parse({ temporaryForSessionId: id, filename: "image.png", contentType: "image/png", sizeBytes: 1 }).temporaryForSessionId).toBe(id);
});

import {AccessGrant} from '../src';
import {createSessionForRequest} from '@opengeni/core';
import {testSettings} from '@opengeni/testing';
test('native image admission rejects memory/tool/default-skill expansion before any database read',async()=>{
 const grant=AccessGrant.parse({accountId:crypto.randomUUID(),workspaceId:crypto.randomUUID(),subjectId:'synthetic-assessor',permissions:['sessions:create']});
 const payload=CreateSessionRequest.parse({requestedSessionId:crypto.randomUUID(),initialMessage:'Synthetic image check',resources:[{kind:'file',fileId:id,asImage:true}],
  rigId:null,variableSetIds:[],sandboxBackend:'none',agentAccess:'session',memoryScope:'off',policyRole:'evidence-assessor',tools:[],mcpServers:[],firstPartyMcpTools:[],bundledSkillIds:[],skills:[]});
 const poisonDb=new Proxy({},{get(){throw new Error('Invalid image scope touched database');}});
 const deps={db:poisonDb,settings:testSettings()} as never;
 for(const expansion of [{rigId:undefined},{rigId:id},{variableSetIds:[id]},{sandboxBackend:'local'},{targetSandboxId:id},{goal:GoalSpec.parse({text:'Synthetic ongoing objective'})},{personalResourceAttachment:PersonalResourceAttachmentIntent.parse({mode:UserResourceLifecycleGrantMode.options[0],sharedOutputWarningVersion:PERSONAL_RESOURCE_SHARED_OUTPUT_WARNING_VERSION})},{memoryScope:'workspace'},{agentAccess:'workspace'},{firstPartyMcpTools:undefined},{bundledSkillIds:undefined},
   {tools:[{kind:'mcp',id:'synthetic-tool'}]},{mcpServers:[SessionMcpServerInput.parse({id:'synthetic-tool',url:'https://example.test/synthetic-tool'})]}]){
  await expect(createSessionForRequest(deps,grant,grant.workspaceId,{...payload,...expansion})).rejects.toThrow('Image-only sessions require isolated tool-less scope');
 }
});

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { canonicalModelSourceJson, SKILL_CATALOG_CONTEXT_PREFIX, readSkillCatalogContext, ModelCallSourceReceipt, MODEL_CALL_SOURCE_MAX_INPUTS, ImportedMessageOrigin, IMPORTED_HISTORY_CONTEXT_HEADER, ModelSourceRef, type ModelSourceInput, type ModelSourceBinding, type ModelHistorySourceBasis, type ModelSourceClosureNode, type ModelCallSourceBasisResponse } from "@opengeni/contracts";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";
import { resolveCompanyBrainContextSelection } from "./company-brain-context-selection";

export const modelSourceContentDigest = (value: unknown): string => { canonicalModelSourceJson(value); return createHash("sha256").update(JSON.stringify(value)).digest("hex"); };
export type NativeModelSourceRequest = { instructions?: unknown; input?: unknown; tools?: unknown; purpose?: ModelCallSourceReceipt["purpose"]; sourceBindings?:readonly ModelSourceBinding[]; instructionSelections?:{instructionPolicySnapshotId:string;preferenceSnapshotId:string|null;companyProfileSnapshotId:string} };
export type ModelCallSourceIdentity = { accountId: string; workspaceId: string; sessionId: string; turnId: string; attemptId: string; executionGeneration: number; sourceKey: string; requestIndex: number };
type Basis = ModelHistorySourceBasis;
/** Validate the immutable persisted bytes before accepting a receipt as ancestry. */
export function validatedStoredModelCallSourceReceipt(row:{receipt:unknown;canonical:string;digest:string}):ModelCallSourceReceipt {
 const receipt=ModelCallSourceReceipt.parse(row.receipt);const {digest,...payload}=receipt;
 if(canonicalModelSourceJson(payload)!==row.canonical || digest!==row.digest || createHash("sha256").update(row.canonical).digest("hex")!==digest)throw new Error("MODEL_CALL_SOURCE_RECEIPT_DIGEST_MISMATCH");
 return receipt;
}

/** Exact-call native producer. No model, provider, host lookup or other network occurs in this transaction. */
export async function persistModelCallSourceReceiptWithFence(db: Database, identity: ModelCallSourceIdentity, request: NativeModelSourceRequest, assertFence:(tx:Database)=>Promise<void>): Promise<ModelCallSourceReceipt> {
  return withRlsContext(db, {accountId:identity.accountId,workspaceId:identity.workspaceId}, scoped => scoped.transaction(async tx => {
    await assertFence(tx);
    const reasons = new Set<ModelCallSourceReceipt["incompleteReasons"][number]>();
    const rows = await tx.select({id:schema.sessionHistoryItems.id,item:schema.sessionHistoryItems.item,basis:schema.sessionHistoryItems.sourceBasis,
      rowSha:sql<string>`encode(sha256(convert_to(${schema.sessionHistoryItems.item}::text,'UTF8')),'hex')`})
      .from(schema.sessionHistoryItems).where(and(eq(schema.sessionHistoryItems.accountId,identity.accountId),eq(schema.sessionHistoryItems.workspaceId,identity.workspaceId),eq(schema.sessionHistoryItems.sessionId,identity.sessionId),eq(schema.sessionHistoryItems.active,true))).orderBy(schema.sessionHistoryItems.position);
    // These native producers carried instruction text before retained origins were installed.
    // Preserve their transcript, but never invent origins from the visible body on a later call.
    const missingSkillOrigin = async (item: unknown, basis: {kind?:string;parents?:readonly ModelSourceRef[];retainedSources?:readonly ModelSourceRef[]} | null, sessionId: string): Promise<boolean> => {
      if (basis?.retainedSources?.some(ref => ref.owner === "cendra.skill.reviewed_release")) return false;
      // A native copy inherits through its authenticated durable parents; the closure below checks each origin.
      if (basis?.kind === "COPIED" && basis.parents?.some(parent => parent.owner === "session_history_items")) return false;
      const catalog = item && typeof item === "object" ? readSkillCatalogContext(item as Record<string,unknown>) : null;
      if (catalog !== null && catalog.split("\n").some(line => line.startsWith("- {"))) return true;
      const value = item as { type?: string; callId?: string; call_id?: string; name?: string };
      if (value?.type !== "function_call_result") return false;
      if (value.name === "skill_read") return true;
      const callId = value.callId ?? value.call_id;
      if (!callId) return false;
      const [call] = await tx.select({ id: schema.sessionHistoryItems.id }).from(schema.sessionHistoryItems).where(and(
        eq(schema.sessionHistoryItems.accountId, identity.accountId), eq(schema.sessionHistoryItems.workspaceId, identity.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, sessionId),
        sql`${schema.sessionHistoryItems.item}->>'type' = 'function_call'`,
        sql`coalesce(${schema.sessionHistoryItems.item}->>'callId', ${schema.sessionHistoryItems.item}->>'call_id') = ${callId}`,
        sql`${schema.sessionHistoryItems.item}->>'name' = 'skill_read'`,
      )).limit(1);
      return call !== undefined;
    };
    const closureNodes = new Map<string, ModelSourceClosureNode>();
    const closure = async (ref:ModelSourceRef, path:Set<string>, depth=0, expectedPurpose:"AGENT"|"COMPACTION"="COMPACTION"):Promise<boolean> => {
      if (depth>128 || path.size>16384) {reasons.add("CAP_EXCEEDED");return false;}
      if([...closureNodes.values()].some(node=>canonicalModelSourceJson(node.sourceRef)===canonicalModelSourceJson(ref) && node.parents.length===0))return true;
      if(ref.owner==="native.runtime.artifact") {closureNodes.set(`artifact-parent:${ref.id}`,{sourceRef:ref,kind:"INSTRUCTION",parents:[],retainedSources:[]});return true;}
      if(ref.owner==="model_call_source_receipts") {
        if(path.has(ref.id) || !/^[a-f0-9-]{36}$/.test(ref.id))return false;
        const [stored]=await tx.select().from(schema.modelCallSourceReceipts).where(and(eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),eq(schema.modelCallSourceReceipts.id,ref.id))).limit(1);
        if(!stored)return false;
        let receipt:ModelCallSourceReceipt;try{receipt=validatedStoredModelCallSourceReceipt(stored);}catch{return false;}
        if(receipt.digest!==ref.sha256 || receipt.id!==stored.id || receipt.accountId!==identity.accountId || receipt.workspaceId!==identity.workspaceId || receipt.sessionId!==stored.sessionId || receipt.turnId!==stored.turnId || receipt.attemptId!==stored.attemptId || receipt.executionGeneration!==stored.executionGeneration || receipt.sourceKey!==stored.sourceKey || receipt.purpose!==expectedPurpose || !receipt.complete)return false;
        const next=new Set(path);next.add(ref.id);
        const parents=receipt.inputs.flatMap(input=>input.sourceRef?[input.sourceRef]:[]);
        closureNodes.set(`receipt:${ref.id}`,{sourceRef:ref,kind:receipt.purpose==="AGENT"?"HISTORY_ROW":"SUMMARY",parents,retainedSources:receipt.inputs.flatMap(input=>input.retainedSources)});
        // Artifacts/selection nodes are authenticated by the exact stored request digest. History and nested
        // call parents are still recursively resolved from their owners, so a cached graph cannot hide absence.
        for(const node of receipt.closure) {
          if(node.sourceRef.owner!=="session_history_items" && node.sourceRef.owner!=="model_call_source_receipts")closureNodes.set(`receipt-node:${canonicalModelSourceJson(node.sourceRef)}`,node);
        }
        for(const node of receipt.closure) {
          if((node.sourceRef.owner==="session_history_items" || node.sourceRef.owner==="model_call_source_receipts") && !await closure(node.sourceRef,next,depth+1,node.kind==="HISTORY_ROW"?"AGENT":"COMPACTION"))return false;
        }
        return parents.length>0;
      }
      if (ref.owner!=="session_history_items" || !/^[a-f0-9-]{36}$/.test(ref.id) || path.has(ref.id)) return false;
      const [row] = await tx.select({item:schema.sessionHistoryItems.item,basis:schema.sessionHistoryItems.sourceBasis,sessionId:schema.sessionHistoryItems.sessionId,turnId:schema.sessionHistoryItems.turnId,position:schema.sessionHistoryItems.position,rowSha:sql<string>`encode(sha256(convert_to(${schema.sessionHistoryItems.item}::text,'UTF8')),'hex')`})
        .from(schema.sessionHistoryItems).where(and(eq(schema.sessionHistoryItems.accountId,identity.accountId),eq(schema.sessionHistoryItems.workspaceId,identity.workspaceId),eq(schema.sessionHistoryItems.id,ref.id))).limit(1);
      if (!row || row.rowSha!==ref.sha256) return false;
      if (await missingSkillOrigin(row.item,row.basis,row.sessionId)) return false;
      if (!row.basis) {
        // A response written by the source-aware runtime, or after a legacy Skill
        // read/catalog, cannot become source-free merely through selective import.
        const generated = row.item.role === "assistant" || row.item.type === "reasoning";
        if (generated) {
          const [producer] = row.turnId ? await tx.select({id:schema.modelCallSourceReceipts.id}).from(schema.modelCallSourceReceipts).where(and(
            eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),
            eq(schema.modelCallSourceReceipts.sessionId,row.sessionId),eq(schema.modelCallSourceReceipts.turnId,row.turnId))).limit(1) : [];
          if (producer) return false;
          const [skill] = await tx.select({id:schema.sessionHistoryItems.id}).from(schema.sessionHistoryItems).where(and(
            eq(schema.sessionHistoryItems.accountId,identity.accountId),eq(schema.sessionHistoryItems.workspaceId,identity.workspaceId),
            eq(schema.sessionHistoryItems.sessionId,row.sessionId),sql`${schema.sessionHistoryItems.position} < ${row.position}`,
            sql`((${schema.sessionHistoryItems.item}->>'type'='message' and ${schema.sessionHistoryItems.item}->>'role'='developer' and starts_with(${schema.sessionHistoryItems.item}->>'content',${SKILL_CATALOG_CONTEXT_PREFIX}) and strpos(${schema.sessionHistoryItems.item}->>'content','- {')>0) or (${schema.sessionHistoryItems.item}->>'type'='function_call' and ${schema.sessionHistoryItems.item}->>'name'='skill_read'))`)).limit(1);
          if (skill) return false;
        }
        if (canonicalModelSourceJson(row.item).includes("opengeni_context_summary") || canonicalModelSourceJson(row.item).includes(IMPORTED_HISTORY_CONTEXT_HEADER) || ["function_call_result","tool_search_output"].includes((row.item as {type?:string}).type ?? "")) return false;
        closureNodes.set(ref.id,{sourceRef:ref,kind:"HISTORY_ROW",parents:[],retainedSources:[]});
        return true;
      }
      closureNodes.set(ref.id,{sourceRef:ref,kind:row.basis.kind,parents:row.basis.parents,retainedSources:row.basis.retainedSources ?? []});
      if (!Array.isArray(row.basis.parents)||row.basis.parents.length===0) return false;
      if(row.basis.kind==="HISTORY_ROW" && row.basis.parents.length!==1)return false;
      if((row.basis.kind==="SUMMARY" || row.basis.kind==="HISTORY_ROW") && row.basis.parents.filter(parent=>parent.owner==="model_call_source_receipts").length!==1)return false;
      const next = new Set(path);next.add(ref.id);
      for (const parent of row.basis.parents) {
        if((row.basis.kind==="SUMMARY" || row.basis.kind==="HISTORY_ROW") && parent.owner==="model_call_source_receipts") {
          const [scope]=await tx.select({sessionId:schema.modelCallSourceReceipts.sessionId,turnId:schema.modelCallSourceReceipts.turnId}).from(schema.modelCallSourceReceipts).where(and(eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),eq(schema.modelCallSourceReceipts.id,parent.id))).limit(1);
          if(!scope || scope.sessionId!==row.sessionId || scope.turnId!==row.turnId)return false;
        }
        const raw=row.basis.rawToolSource;
        if(parent.owner==="native.tool.result" && raw && raw.nativeModelSourceKey && canonicalModelSourceJson(parent)===canonicalModelSourceJson(raw.rawSourceRef)) {
          if(!row.turnId) return false;
          if(row.item.type==="tool_search_output") {
            const item=row.item as {providerData?:{call_id?:string};status?:string;tools?:unknown};
            if(item.status!==undefined || item.providerData?.call_id!==raw.sourceCallId || !Array.isArray(item.tools)
              || modelSourceContentDigest({tools:item.tools})!==raw.rawSourceRef.sha256)return false;
          }
          const [sourceReceipt]=await tx.select({id:schema.modelCallSourceReceipts.id,digest:schema.modelCallSourceReceipts.digest}).from(schema.modelCallSourceReceipts).where(and(eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),eq(schema.modelCallSourceReceipts.sessionId,row.sessionId),eq(schema.modelCallSourceReceipts.turnId,row.turnId),eq(schema.modelCallSourceReceipts.sourceKey,raw.nativeModelSourceKey))).limit(1);
          if(!sourceReceipt) return false;
          const producerRef={owner:"model_call_source_receipts",id:sourceReceipt.id,sha256:sourceReceipt.digest};
          if(!await closure(producerRef,next,depth+1,"AGENT"))return false;
          closureNodes.set(`tool:${parent.id}`,{sourceRef:parent,kind:"TOOL_RESULT",parents:[producerRef],retainedSources:raw.retainedSources});
        } else if (!await closure(parent,next,depth+1,row.basis.kind==="HISTORY_ROW"?"AGENT":"COMPACTION")) return false;
      }
      return true;
    };
    const inputs:ModelSourceInput[]=[];
    const addArtifact = (value:unknown, purpose:string) => {
      if (value===undefined || value===null || value==="") return;
      const hash=modelSourceContentDigest(value);
      const sourceRef={owner:"native.runtime.artifact",id:`${purpose}:${hash}`,sha256:hash};
      closureNodes.set(`artifact:${purpose}:${hash}`,{sourceRef,kind:"INSTRUCTION",parents:[],retainedSources:[]});
      inputs.push({ordinal:inputs.length,kind:"INSTRUCTION",contentSha256:hash,sourceRef,parents:[],retainedSources:[]});
    };
    addArtifact(request.instructions,"instructions");addArtifact(request.tools,"tools");
    if(request.instructions && request.purpose!=="TITLE" && request.instructionSelections) {
      const {receipt:selection}=await resolveCompanyBrainContextSelection(tx,identity);
      if(selection) {
        const ref={owner:"company_brain_context_selection_receipts",id:selection.id,sha256:selection.selectionHash};
        const retainedSources:ModelSourceRef[]=[]; // Standing Memory is retired; retrieval refs are captured at the raw tool owner.
        retainedSources.push({owner:"company_brain_turn_context_snapshots",id:selection.turnContextSnapshotId,sha256:selection.turnContextSnapshotHash});
        retainedSources.push({owner:"workspace_instruction_policy_snapshots",id:request.instructionSelections.instructionPolicySnapshotId,version:selection.instructionPolicyEntryHash,sha256:selection.instructionPolicyEntryHash});
        if(selection.companyProfileIncluded)retainedSources.push({owner:"company_profile_snapshots",id:request.instructionSelections.companyProfileSnapshotId,version:selection.companyProfileSnapshotHash,sha256:selection.companyProfileSnapshotHash});
        if(selection.preferenceDescriptorHash && request.instructionSelections.preferenceSnapshotId)retainedSources.push({owner:"preference_registry_snapshots",id:request.instructionSelections.preferenceSnapshotId,version:selection.preferenceDescriptorHash,sha256:selection.preferenceDescriptorHash});
        if(selection.legacyWorkspaceInstructionsTruncated)reasons.add("CAP_EXCEEDED");
        closureNodes.set(`selection:${selection.id}`,{sourceRef:ref,kind:"INSTRUCTION",parents:[],retainedSources});
        const instructions=inputs[0];if(instructions){instructions.parents.push(ref);instructions.retainedSources.push(...retainedSources);const node=closureNodes.get(`artifact:instructions:${instructions.contentSha256}`);if(node){node.parents.push(ref);node.retainedSources.push(...retainedSources);}}
      }
    }
    if (!Array.isArray(request.input) && typeof request.input!=="string") reasons.add("UNAVAILABLE_INPUT");
    const values=Array.isArray(request.input)?request.input:typeof request.input==="string"?[request.input]:[];
    const remainingInputs=MODEL_CALL_SOURCE_MAX_INPUTS-inputs.length;
    if (values.length>remainingInputs) reasons.add("CAP_EXCEEDED");
    let cursor=0;
    for (const [ordinal,value] of (values.length>remainingInputs?[]:values).entries()) {
      const binding=request.sourceBindings?.find(candidate=>candidate.ordinal===ordinal);
      const contentSha256=modelSourceContentDigest(value);
      const index=binding?.sourceRef.owner==="session_history_items"?rows.findIndex(row=>row.id===binding.sourceRef.id):rows.findIndex((row,i)=>i>=cursor && modelSourceContentDigest(row.item)===contentSha256);
      const row=index<0?undefined:rows[index];
      if (row) cursor=index+1;
      const basis=row?.basis as Basis|null|undefined;
      if (await missingSkillOrigin(value,basis ?? binding ?? null,identity.sessionId)) reasons.add("UNRESOLVED_PARENT");
      let kind:ModelSourceInput["kind"]=basis?.kind??((value as {type?:string})?.type==="function_call_result"?"TOOL_RESULT":"HISTORY_ROW");
      // Historical derived rows have no owner closure. A summary marker never authenticates ancestry.
      if (!basis && canonicalModelSourceJson(value).includes("opengeni_context_summary")) {kind="SUMMARY";reasons.add("UNRESOLVED_PARENT");}
      let sourceRef=binding?.sourceRef ?? (row?{owner:"session_history_items",id:row.id,sha256:row.rowSha}:null);
      const parents=[...(basis?.parents??binding?.parents??[])];
      let retainedSources=basis?.retainedSources ?? binding?.retainedSources ?? [];
      if(sourceRef?.owner==="native.runtime.artifact" && (binding?.kind==="HISTORY_ROW" || binding?.kind==="TOOL_RESULT") && !binding.nativeProducerSourceKey)
        reasons.add("UNRESOLVED_PARENT");
      if(binding?.nativeProducerSourceKey) {
        // Transient SDK output is admitted only against its exact committed call,
        // in this still-current attempt. A projection digest is not the raw tool digest.
        const [stored]=await tx.select().from(schema.modelCallSourceReceipts).where(and(
          eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),
          eq(schema.modelCallSourceReceipts.sessionId,identity.sessionId),eq(schema.modelCallSourceReceipts.turnId,identity.turnId),
          eq(schema.modelCallSourceReceipts.attemptId,identity.attemptId),eq(schema.modelCallSourceReceipts.executionGeneration,identity.executionGeneration),
          eq(schema.modelCallSourceReceipts.sourceKey,binding.nativeProducerSourceKey))).limit(1);
        let producer:ModelCallSourceReceipt|null=null;
        if(stored) {try {producer=validatedStoredModelCallSourceReceipt(stored);}catch { /* Refuse unavailable immutable ancestry. */ }}
        if(sourceRef?.owner!=="native.runtime.artifact" || sourceRef.sha256!==contentSha256 || !producer || !producer.complete || producer.incompleteReasons.length!==0
          || producer.purpose!=="AGENT" || producer.requestIndex>=identity.requestIndex
          || producer.accountId!==identity.accountId || producer.workspaceId!==identity.workspaceId || producer.sessionId!==identity.sessionId
          || producer.turnId!==identity.turnId || producer.attemptId!==identity.attemptId || producer.executionGeneration!==identity.executionGeneration
          || producer.sourceKey!==binding.nativeProducerSourceKey || producer.id!==stored?.id) {
          reasons.add("UNRESOLVED_PARENT");
        } else {
          // Reuse authenticated native leaves, while resolving history and nested
          // compaction ancestry again through their owners rather than a cached graph.
          for(const node of producer.closure)if(node.sourceRef.owner!=="session_history_items" && node.sourceRef.owner!=="model_call_source_receipts")
            closureNodes.set(`producer-node:${canonicalModelSourceJson(node.sourceRef)}`,node);
          const ancestors=producer.inputs.flatMap(input=>input.sourceRef?[input.sourceRef]:[]);
          for(const ancestor of ancestors)if(!await closure(ancestor,new Set()))reasons.add("UNRESOLVED_PARENT");
          parents.push(...ancestors);
          // Inputs and closure repeat the same evidence across SDK continuations.
          // Union the full released reference identity; differing owners, ids,
          // digests or versions remain distinct and all owner checks still run.
          retainedSources=[...new Map([...retainedSources,...producer.inputs.flatMap(input=>input.retainedSources),...producer.closure.flatMap(node=>node.retainedSources)]
            .map(ref=>[canonicalModelSourceJson(ref),ref])).values()];
          const raw=binding.rawToolSource;
          if(binding.kind==="TOOL_RESULT") {
            const item=value as {type?:string;callId?:string;providerData?:{call_id?:string};tools?:unknown;status?:string};
            const search=item.type==="tool_search_output";
            const callId=search?item.providerData?.call_id:item.callId;
            const rawSearch=binding.rawToolResult as {tools?:unknown}|null|undefined;
            const exactSearch=!search || ((item.status==="completed" || item.status===undefined) && Array.isArray(item.tools) && rawSearch && Array.isArray(rawSearch.tools)
              && canonicalModelSourceJson(item.tools)===canonicalModelSourceJson(rawSearch.tools));
            if(!raw || (!search && item.type!=="function_call_result") || !exactSearch || callId!==raw.sourceCallId || raw.nativeModelSourceKey!==producer.sourceKey
              || raw.rawSourceRef.owner!=="native.tool.result" || !ModelSourceRef.safeParse(raw.rawSourceRef).success
              || binding.rawToolResult===undefined || modelSourceContentDigest(binding.rawToolResult)!==raw.rawSourceRef.sha256
              || canonicalModelSourceJson(binding.parents)!==canonicalModelSourceJson([raw.rawSourceRef])
              || canonicalModelSourceJson(binding.retainedSources)!==canonicalModelSourceJson(raw.retainedSources))reasons.add("UNRESOLVED_PARENT");
            else closureNodes.set(`tool:${raw.rawSourceRef.id}`,{sourceRef:raw.rawSourceRef,kind:"TOOL_RESULT",parents:[],retainedSources:raw.retainedSources});
          } else if(raw || binding.parents.length!==0 || binding.retainedSources.length!==0)reasons.add("UNRESOLVED_PARENT");
        }
      }
      if(typeof value==="string" && request.purpose==="TITLE") {
        const [turn]=await tx.select({prompt:schema.sessionTurns.prompt,metadata:schema.sessionTurns.metadata}).from(schema.sessionTurns).where(and(eq(schema.sessionTurns.accountId,identity.accountId),eq(schema.sessionTurns.workspaceId,identity.workspaceId),eq(schema.sessionTurns.sessionId,identity.sessionId),eq(schema.sessionTurns.id,identity.turnId))).limit(1);
        if(turn) {
          sourceRef={owner:"native.runtime.artifact",id:`title-input:${contentSha256}`,sha256:contentSha256};
          const parent={owner:"session_turns",id:identity.turnId,sha256:modelSourceContentDigest(turn.prompt)};parents.push(parent);
          retainedSources=ModelSourceRef.array().max(16384).parse(turn.metadata?.nativeMessageModelSourceRefs ?? []);
          closureNodes.set(`turn:${identity.turnId}`,{sourceRef:parent,kind:"HISTORY_ROW",parents:[],retainedSources});
        }
      }
      if(sourceRef?.owner==="native.runtime.artifact") {for(const parent of parents) if(!await closure(parent,new Set())) reasons.add("UNRESOLVED_PARENT");}
      if(sourceRef?.owner==="native.runtime.artifact") closureNodes.set(`artifact:${sourceRef.id}:${sourceRef.sha256}`,{sourceRef,kind:binding?.kind ?? kind,parents,retainedSources});
      if (!sourceRef) reasons.add("UNKNOWN_SOURCE");
      else if (sourceRef.owner!=="native.runtime.artifact" && !await closure(sourceRef,new Set())) reasons.add(kind==="IMPORTED"?"UNATTRIBUTED_IMPORT":"UNRESOLVED_PARENT");
      inputs.push({ordinal:inputs.length,kind,contentSha256,sourceRef,parents,retainedSources});
    }
    if (values.length===0) reasons.add("EMPTY_BASIS");
    const payload={version:1 as const,id:randomUUID(),...identity,purpose:request.purpose ?? "AGENT",inputs,closure:[...closureNodes.values()],complete:reasons.size===0,incompleteReasons:[...reasons].sort()};
    const canonical=canonicalModelSourceJson(payload);
    if (Buffer.byteLength(canonical)>16*1024*1024) throw new RangeError("MODEL_CALL_SOURCE_RECEIPT_CAP_EXCEEDED");
    const digest=createHash("sha256").update(canonical).digest("hex");
    const receipt=ModelCallSourceReceipt.parse({...payload,digest});
    await tx.insert(schema.modelCallSourceReceipts).values({...identity,id:receipt.id,receipt,canonical,digest});
    return receipt;
  }));
}

/** Reads one exact call, never a latest-per-attempt snapshot. API establishes subject/session visibility first. */
export async function readModelCallSourceReceipt(db:Database, identity:Pick<ModelCallSourceIdentity,"accountId"|"workspaceId"|"sessionId"|"sourceKey">):Promise<ModelCallSourceBasisResponse> {
 return withRlsContext(db,{accountId:identity.accountId,workspaceId:identity.workspaceId},async scoped=>{
  const [row]=await scoped.select().from(schema.modelCallSourceReceipts).where(and(eq(schema.modelCallSourceReceipts.accountId,identity.accountId),eq(schema.modelCallSourceReceipts.workspaceId,identity.workspaceId),eq(schema.modelCallSourceReceipts.sessionId,identity.sessionId),eq(schema.modelCallSourceReceipts.sourceKey,identity.sourceKey))).limit(1);
  if (!row) return {schema:"cendra.native-source-basis/v1",receipt:null};
  const receipt=validatedStoredModelCallSourceReceipt(row);
  return {schema:"cendra.native-source-basis/v1",receipt};
 });
}

/** Freeze imported ancestry in the initial durable user row, never infer authority from its heading. */
export async function importedHistorySourceBasisTx(tx:Database, input:{accountId:string;workspaceId:string;context:string|null;metadata:Record<string,unknown>}):Promise<ModelHistorySourceBasis|undefined> {
  if(!input.context || !Object.hasOwn(input.metadata,"nativeImportedHistoryOrigins")) return undefined;
  const values=input.metadata.nativeImportedHistoryOrigins;
  if(!Array.isArray(values) || values.length===0 || values.some(value=>!ImportedMessageOrigin.safeParse(value).success)) return {kind:"IMPORTED",parents:[]};
  const origins=values.map(value=>ImportedMessageOrigin.parse(value));
  const parents:ModelSourceRef[]=origins.map(origin=>({owner:origin.source,id:origin.externalId,sha256:origin.sha256}));
  const lines:string[]=[];
  for(const parent of parents) {
    if(parent.owner!=="session_history_items" || !/^[a-f0-9-]{36}$/.test(parent.id)) return {kind:"IMPORTED",parents};
    const [row]=await tx.select({item:schema.sessionHistoryItems.item,sha256:sql<string>`encode(sha256(convert_to(${schema.sessionHistoryItems.item}::text,'UTF8')),'hex')`}).from(schema.sessionHistoryItems).where(and(eq(schema.sessionHistoryItems.accountId,input.accountId),eq(schema.sessionHistoryItems.workspaceId,input.workspaceId),eq(schema.sessionHistoryItems.id,parent.id))).limit(1);
    if(!row || row.sha256!==parent.sha256 || !["user","assistant","system"].includes(String(row.item.role))) return {kind:"IMPORTED",parents:[]};
    const content=row.item.content;
    const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part && typeof part==="object" && "text" in part && typeof part.text==="string")?content.map(part=>(part as {text:string}).text).join("\n"):null;
    if(text===null)return {kind:"IMPORTED",parents:[]};
    lines.push(`${row.item.role}: ${text}`);
  }
  // Any filtering, partial line, omission, extra context or truncation is explicitly unattributed.
  return {kind:"IMPORTED",parents:input.context===`${IMPORTED_HISTORY_CONTEXT_HEADER}\n${lines.join("\n")}`?parents:[]};
}

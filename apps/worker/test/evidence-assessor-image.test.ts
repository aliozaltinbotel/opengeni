import {expect,test} from 'bun:test';
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

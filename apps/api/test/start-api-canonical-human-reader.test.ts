import { describe, expect, test } from 'bun:test';
import type { Database } from '@opengeni/db';
import { bindStartApiCanonicalHumanIdentityReader, type CanonicalHumanIdentityReader } from '../src/index';

const identity = (status: 'active' | 'disabled') => ({
  activeIdentity: { id:'019a0000-0000-7000-8000-000000000001',displayName:'Synthetic lifecycle fixture',status,
    identityRevision:1,authRevision:1,activeLoginBindingId:null,recoveryState:'ready',
    createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z' },loginBindings:[],
});

describe('API-owned canonical human reader lifecycle',()=>{
 test('standalone start has no host callback and performs no identity lookup',async()=>{
  const db={execute(){throw new Error('UNEXPECTED_IDENTITY_READ');}} as unknown as Database;
  await bindStartApiCanonicalHumanIdentityReader(db,{});
 });
 test('binding is awaited and never reads or transfers an identity result',async()=>{
  const db={execute(){throw new Error('BINDING_MUST_NOT_READ');}} as unknown as Database;
  let release:()=>void=()=>{throw new Error('BINDING_NOT_ENTERED');};let finished=false;
  const pending=bindStartApiCanonicalHumanIdentityReader(db,{onCanonicalHumanIdentityReader:async read=>{
   expect(typeof read).toBe('function');await new Promise<void>(resolve=>{release=resolve;});
  }}).then(()=>{finished=true;});
  await Promise.resolve();expect(finished).toBe(false);release();await pending;expect(finished).toBe(true);
 });
 test('the borrowed reader executes the existing public getter afresh, maps missing only, and propagates failure',async()=>{
  let reads=0;let mode:'active'|'disabled'|'missing'|'failure'='active';
  const failure=new Error('SYNTHETIC_DATABASE_UNAVAILABLE');
  const db={async execute(){reads++;if(mode==='failure')throw failure;return [{projection:mode==='missing'?null:identity(mode)}];}} as unknown as Database;
  let reader:CanonicalHumanIdentityReader|undefined;
  await bindStartApiCanonicalHumanIdentityReader(db,{onCanonicalHumanIdentityReader:read=>{reader=read;}});
  if(!reader)throw new Error('READER_NOT_BOUND');
  expect((await reader('synthetic-owned-user'))?.activeIdentity.status).toBe('active');
  mode='disabled';expect((await reader('synthetic-owned-user'))?.activeIdentity.status).toBe('disabled');
  mode='missing';expect(await reader('synthetic-missing-user')).toBeNull();
  mode='failure';await expect(reader('synthetic-owned-user')).rejects.toBe(failure);
  expect(reads).toBe(4);
 });
 test('callback rejection fails the startup boundary without replacing it with a reader or a database handle',async()=>{
  const failure=new Error('SYNTHETIC_HOST_BINDING_FAILED');
  await expect(bindStartApiCanonicalHumanIdentityReader({} as Database,{onCanonicalHumanIdentityReader:()=>{throw failure;}})).rejects.toBe(failure);
 });
});

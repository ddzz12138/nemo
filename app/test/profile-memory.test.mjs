import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProfileMemoryRuntime,createProfileMemoryReader,migrateOwnerMemory} from '../lib/profile-memory.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function fixture(t){const configDir=await mkdtemp(fileURLToPath(new URL('./.tmp-profile-memory-',import.meta.url)));t.after(()=>rm(configDir,{recursive:true,force:true}));return configDir;}
test('missing/foreign profile context fails before opening a memory database',async t=>{
  const configDir=await fixture(t);let calls=0;const clientFactory=async()=>{calls++;return{status:async()=>({connected:false})};};
  for(const input of [{},{profileId:A,dataDir:configDir,configDir},{profileId:B,dataDir:join(configDir,'profiles',A),configDir},{profileId:'../owner',dataDir:configDir,configDir}])await assert.rejects(createProfileMemoryRuntime({...input,clientFactory}));
  assert.equal(calls,0);
  await assert.rejects(createProfileMemoryReader({profileId:A,profileDataDir:configDir}));
});
test('new profiles stay empty with source copying off and never fall back to root memory',async t=>{
  const configDir=await fixture(t),profileDataDir=join(configDir,'profiles',A);await mkdir(profileDataDir,{recursive:true});
  await writeFile(join(configDir,'gbrain-runtime.json'),JSON.stringify({dataDir:join(configDir,'gbrain-data'),runtimePath:'ROOT_MUST_NOT_BE_USED',sourceRoot:'ROOT_MUST_NOT_BE_USED'}));
  const runtime=await createProfileMemoryRuntime({configDir,dataDir:profileDataDir,profileId:A,gmail:{},calendar:{}});
  assert.equal(runtime.status().engine.connected,false);assert.deepEqual(runtime.status().sources,{gmail:false,calendar:false});
  const reader=await createProfileMemoryReader({profileId:A,profileDataDir});assert.equal((await reader.status()).connected,false);
  await writeFile(join(profileDataDir,'gbrain-runtime.json'),JSON.stringify({dataDir:join(configDir,'gbrain-data'),runtimePath:'ROOT_MUST_NOT_BE_USED',sourceRoot:'ROOT_MUST_NOT_BE_USED'}));
  const foreign=await createProfileMemoryReader({profileId:A,profileDataDir});assert.equal((await foreign.status()).connected,false);
});
test('explicit setup creates only the bound profile mapping and does not enable mirroring',async t=>{
  const configDir=await fixture(t),dataDir=join(configDir,'profiles',A);await mkdir(dataDir,{recursive:true});
  await writeFile(join(configDir,'gbrain-engine.json'),JSON.stringify({runtimePath:'PINNED_BUN',sourceRoot:'PINNED_SOURCE'}));
  let configured=false;const setups=[];const calls=[];
  const runtime=await createProfileMemoryRuntime({configDir,dataDir,profileId:A,gmail:{},calendar:{},setup:async home=>{setups.push(home);},localClientFactory:config=>{calls.push(config);return{status:async()=>{configured=true;return{connected:true,embedding:'local-ollama'};}};},clientFactory:async input=>({status:async()=>({connected:configured,embedding:configured?'local-ollama':undefined}),mirrorCopies:async()=>({ok:true,desiredCount:0})})});
  assert.equal(runtime.enable().initializing,true);await runtime.close();
  assert.deepEqual(setups,[join(dataDir,'gbrain-data')]);assert.equal(calls[0].dataDir,join(dataDir,'gbrain-data'));
  const mapping=JSON.parse(await readFile(join(dataDir,'gbrain-runtime.json'),'utf8'));assert.equal(mapping.dataDir,join(dataDir,'gbrain-data'));
  assert.equal(runtime.engine.connected,true);assert.deepEqual(runtime.status().sources,{gmail:false,calendar:false});
  assert.equal(runtime.status().setupError,undefined);
  assert.equal((await readFile(join(dataDir,'gbrain-runtime.json'),'utf8')).includes(B),false);
});

test('an unused profile can connect Gmail before Memory is enabled without opening a database',async t=>{
  const configDir=await fixture(t),dataDir=join(configDir,'profiles',A);await mkdir(dataDir,{recursive:true});
  const runtime=await createProfileMemoryRuntime({configDir,dataDir,profileId:A,gmail:{},calendar:{}});
  const result=await runtime.mirror.clear('gmail');
  assert.equal(result.ok,true);assert.equal(result.desiredCount,0);assert.equal(result.uninitialized,true);
  assert.equal(runtime.status().engine.connected,false);assert.deepEqual(runtime.status().sources,{gmail:false,calendar:false});
  await assert.rejects(readFile(join(dataDir,'gbrain-runtime.json')), {code:'ENOENT'});
  await assert.rejects(readFile(join(dataDir,'memory-mirror.json')), {code:'ENOENT'});
});

for(const presence of ['mapping','database'])test(`an unavailable profile with a ${presence} cannot skip source cleanup, even when it appears after startup`,async t=>{
  const configDir=await fixture(t),dataDir=join(configDir,'profiles',A);await mkdir(dataDir,{recursive:true});
  const runtime=await createProfileMemoryRuntime({configDir,dataDir,profileId:A,gmail:{},calendar:{}});
  assert.equal((await runtime.mirror.clear('gmail')).uninitialized,true);
  if(presence==='mapping')await writeFile(join(dataDir,'gbrain-runtime.json'),'{}');
  else await mkdir(join(dataDir,'gbrain-data'));
  await assert.rejects(runtime.mirror.clear('gmail'), {code:'MEMORY_MIRROR'});
  assert.ok(runtime.status().error);
});

for(const prior of ['enabled','copies'])test(`recorded ${prior} prevent uninitialized Memory from bypassing source cleanup`,async t=>{
  const configDir=await fixture(t),dataDir=join(configDir,'profiles',A);await mkdir(dataDir,{recursive:true});
  const previous=JSON.stringify({version:1,sources:{gmail:prior==='enabled',calendar:false},counts:{gmail:prior==='copies'?1:0,calendar:0},excluded:[],fingerprints:{}});
  await writeFile(join(dataDir,'memory-mirror.json'),previous);
  const runtime=await createProfileMemoryRuntime({configDir,dataDir,profileId:A,gmail:{},calendar:{}});
  await assert.rejects(runtime.mirror.clear('gmail'),{code:'MEMORY_MIRROR'});
  assert.equal(await readFile(join(dataDir,'memory-mirror.json'),'utf8'),previous);
});
test('setup failures are sanitized, preserve disconnected state and may be retried',async t=>{
  const configDir=await fixture(t),dataDir=join(configDir,'profiles',A);await mkdir(dataDir,{recursive:true});
  await writeFile(join(configDir,'gbrain-engine.json'),JSON.stringify({runtimePath:'fixture',sourceRoot:'fixture'}));
  const runtime=await createProfileMemoryRuntime({configDir,dataDir,profileId:A,gmail:{},calendar:{},setup:async()=>{throw Error('PRIVATE_INFORMATION');},localClientFactory:()=>({}),clientFactory:async()=>({status:async()=>({connected:false})})});
  runtime.enable();await runtime.close();assert.ok(runtime.status().setupError);assert.equal(JSON.stringify(runtime.status()).includes('PRIVATE_INFORMATION'),false);assert.equal(runtime.engine.connected,false);
});
test('owner migration refuses a family member and a running managed server',async t=>{
  const configDir=await fixture(t);await writeFile(join(configDir,'profiles.json'),JSON.stringify({ownerProfileId:A,profiles:[{id:A,role:'owner'},{id:B,role:'member'}]}));
  await assert.rejects(migrateOwnerMemory({dataDir:configDir,profileId:B}),error=>error.code==='GBRAIN_PROFILE');
  await writeFile(join(configDir,'server.pid'),String(process.pid));
  await assert.rejects(migrateOwnerMemory({dataDir:configDir,profileId:A}),error=>error.code==='GBRAIN_BUSY');
});

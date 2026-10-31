import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeChat,configureNativePreview,loadNativeSettings } from '../lib/native-chat.mjs';
import { nativeFake } from './helpers/native-fake.mjs';
import {connectionTools} from '../lib/connections.mjs';

async function fixture(t,options={}){
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-chat-')),a={id:randomUUID(),role:'owner'},b={id:randomUUID(),role:'member',classification:'adult'};const profiles=new Map([[a.id,a],[b.id,b]]);const fake=nativeFake(options);
  const chat=await createNativeChat({dataDir,getProfile:id=>profiles.get(id),isDeviceActive:async device=>device==='synthetic-device',sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake,...(options.forward?{forward:options.forward}:{} )});
  t.after(async()=>{await chat.close();await rm(dataDir,{recursive:true,force:true});});return{chat,a,b,fake,profiles};
}
async function completed(chat,profileId,id){for(let i=0;i<150;i++){const {task}=await chat.get(profileId,id);if(!['queued','running'].includes(task.phase))return task;await delay(10);}throw new Error('Synthetic task did not settle.');}
const submit=(chat,profile,message,requestKey=randomUUID())=>chat.submit(profile.id,{requestKey,message,deviceId:'synthetic-device'});

test('preview setup requires verified runtime paths and disabling it preserves private tasks',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-settings-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  assert.equal((await loadNativeSettings(dataDir)).enabled,false);
  const options={dataDir,enabled:true,pythonPath:process.execPath,sourceRoot:dataDir,hermesHome:dataDir,apiMode:'codex_responses',verifyRuntime:async()=>({supported:true,policy:'chat-only'})};
  await assert.rejects(configureNativePreview({...options,apiMode:'unknown'}),/supported/);assert.equal((await loadNativeSettings(dataDir)).enabled,false);
  await assert.rejects(configureNativePreview({...options,verifyRuntime:async()=>({supported:false})}),/compatible/);
  await configureNativePreview(options);assert.equal((await loadNativeSettings(dataDir)).apiMode,'codex_responses');
  await configureNativePreview({dataDir,enabled:false});assert.deepEqual(await loadNativeSettings(dataDir),{version:1,enabled:false});
});

test('native preview isolates two profiles, binds provider tasks and never dispatches duplicate requests',async t=>{
  const f=await fixture(t),key=randomUUID();
  const [first,second]=await Promise.all([submit(f.chat,f.a,'SYNTHETIC_AMBER',key),submit(f.chat,f.b,'SYNTHETIC_BLUE')]);
  assert.equal((await submit(f.chat,f.a,'SYNTHETIC_AMBER',key)).created,false);
  const [a,b]=await Promise.all([completed(f.chat,f.a.id,first.task.id),completed(f.chat,f.b.id,second.task.id)]);
  assert.equal(a.phase,'complete');assert.equal(b.phase,'complete');assert.ok(a.text.includes('SYNTHETIC_AMBER'));assert.ok(!a.text.includes('SYNTHETIC_BLUE'));assert.ok(!b.text.includes('SYNTHETIC_AMBER'));assert.equal(f.fake.prompts,2);
  await assert.rejects(f.chat.get(f.a.id,second.task.id),{code:'TASK_NOT_FOUND'});
  assert.ok(f.fake.calls.every(call=>call.taskId&&call.profileId));assert.ok(!JSON.stringify(a).includes('PRIVATE_INTERNAL_VALUE'));
  assert.equal(f.chat.status(f.a.id).verified,true);
  const third=await submit(f.chat,f.a,'/shell harmless text only');await completed(f.chat,f.a.id,third.task.id);assert.ok(f.fake.calls.at(-1).body.messages.at(-1).content.startsWith('User message:\n/shell'));
  assert.ok(f.fake.calls.at(-1).body.messages.some(message=>message.content.includes('SYNTHETIC_AMBER')));
});

test('a failed provider pauses native work on its first inference attempt',async t=>{
  let attempts=0;const f=await fixture(t,{forward:async input=>{if(input.path==='/v1/models')return Response.json({data:[{id:'synthetic-model'}]});attempts++;return Response.json({error:'Synthetic provider unavailable'},{status:502});}});
  const submitted=await submit(f.chat,f.a,'Synthetic failure only');const task=await completed(f.chat,f.a.id,submitted.task.id);assert.equal(task.phase,'paused');assert.equal(attempts,1);assert.equal(f.chat.status(f.a.id).verified,false);
});

test('closing during private History startup stops the late worker and shares one shutdown promise',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-close-')),profile={id:randomUUID()},fake=nativeFake();
  let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const chat=await createNativeChat({dataDir,getProfile:async()=>profile,sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake,startWorker:async options=>{enter();await gate;return fake.startWorker(options);}});
  t.after(async()=>{release();await chat.close();await rm(dataDir,{recursive:true,force:true});});
  const created=await chat.newConversation(profile.id),reading=chat.conversation(profile.id,created.conversation.id);
  await entered;const closing=chat.close();assert.equal(chat.close(),closing);release();const [,projection]=await Promise.all([closing,reading]);assert.equal(projection.stale,true);
  assert.equal(fake.workers.length,1);assert.ok(fake.workers.every(worker=>worker.client.closed));assert.equal(fake.prompts,0);
});

test('native stop and revocation prevent late results from completing or replaying work',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);const f=await fixture(t,{beforeReply:()=>gate});
  const submitted=await submit(f.chat,f.a,'Synthetic cancellable task');
  for(let i=0;i<100&&!f.fake.calls.length;i++)await delay(5);
  assert.equal(f.fake.calls.length,1);await assert.rejects(f.chat.newConversation(f.a.id),{code:'RUN_ACTIVE'});await f.chat.stop(f.a.id,submitted.task.id);release();
  await delay(30);const {task}=await f.chat.get(f.a.id,submitted.task.id);assert.equal(task.phase,'cancelled');assert.equal(task.text,'');
  await assert.rejects(f.chat.submit(f.a.id,{requestKey:randomUUID(),message:'No active device',deviceId:'revoked'}),{status:401});
  f.a.policyRevision=1;await f.chat.invalidate(f.a.id);
  assert.equal((await f.chat.get(f.a.id,submitted.task.id)).task.phase,'cancelled');
});

test('read-tool budgets pause durably and require a private one-time explicit extension',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-budget-')),profile={id:randomUUID()},other=randomUUID();let reads=0,more=true;
  const tool={name:'memory_search',arguments:{query:'synthetic'}};
  const fake=nativeFake({toolForPrompt:()=>more?[tool,tool]:tool}),chat=await createNativeChat({dataDir,getProfile:id=>id===profile.id?profile:{id},isDeviceActive:async device=>device==='synthetic-device',sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake,limits:{activeMs:600000,toolCalls:1,subagents:2},connectionsForProfile:async()=>({key:'a'.repeat(64),tools:connectionTools,async execute(){reads++;return{synthetic:true};}})});
  t.after(async()=>{await chat.close();await rm(dataDir,{recursive:true,force:true});});
  const submitted=await submit(chat,profile,'Synthetic repeated lookup');
  const paused=await completed(chat,profile.id,submitted.task.id);assert.equal(paused.phase,'paused');assert.equal(paused.reason,'budget');assert.equal(reads,1);assert.equal(paused.tools,1);
  await assert.rejects(chat.extend(other,submitted.task.id,{deviceId:'synthetic-device'}),{code:'TASK_NOT_FOUND'});
  await assert.rejects(chat.extend(profile.id,submitted.task.id,{deviceId:'revoked'}),{status:401});
  more=false;await chat.extend(profile.id,submitted.task.id,{deviceId:'synthetic-device'});
  await assert.rejects(chat.extend(profile.id,submitted.task.id,{deviceId:'synthetic-device'}),{status:409});
  const done=await completed(chat,profile.id,submitted.task.id);assert.equal(done.phase,'complete');assert.equal(reads,2);assert.equal(done.tools,2);
});

test('existing zero-tool preview continuity is preserved when scoped reads are still off',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-adoption-')),profile={id:randomUUID()},fake=nativeFake(),base={dataDir,getProfile:id=>id===profile.id?profile:null,isDeviceActive:async()=>true,sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake};let chat=await createNativeChat(base);
  t.after(async()=>{await chat.close();await rm(dataDir,{recursive:true,force:true});});
  const first=await submit(chat,profile,'SYNTHETIC_OLD_PREVIEW');await completed(chat,profile.id,first.task.id);await chat.close();
  chat=await createNativeChat({...base,connectionsForProfile:async()=>({key:'a'.repeat(64),tools:[]})});const next=await submit(chat,profile,'Continue my synthetic plain conversation');assert.equal((await completed(chat,profile.id,next.task.id)).phase,'complete');assert.ok(fake.calls.at(-1).body.messages.some(message=>message.content.includes('SYNTHETIC_OLD_PREVIEW')));
});

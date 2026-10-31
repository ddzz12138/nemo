import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeChat} from '../lib/native-chat.mjs';
import {createNativeHistory,projectTranscript,nativePrompt} from '../lib/native-history.mjs';
import {nativeFake} from './helpers/native-fake.mjs';

async function fixture(t,options={}){
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-history-')),a={id:randomUUID(),role:'owner'},b={id:randomUUID(),role:'member',classification:'adult'},profiles=new Map([[a.id,a],[b.id,b]]),fake=nativeFake();
  const chat=await createNativeChat({dataDir,getProfile:id=>profiles.get(id),isDeviceActive:async()=>true,sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake,...options});
  t.after(async()=>{await chat.close();await rm(dataDir,{recursive:true,force:true});});
  const send=async(profile,message,conversationId)=>{const submitted=await chat.submit(profile.id,{requestKey:randomUUID(),message,deviceId:'fixture',...(conversationId?{conversationId}:{})});for(let i=0;i<200&&chat.isBusy(profile.id);i++)await delay(10);const value=(await chat.get(profile.id,submitted.task.id)).task;assert.equal(value.phase,'complete');return value;};return{chat,a,b,fake,send,dataDir};
}

test('native History searches only this profile and renders the Hermes transcript without prompt scaffolding',async t=>{
  const f=await fixture(t);const first=await f.send(f.a,'SYNTHETIC_AMBER_NOTE');await f.send(f.b,'SYNTHETIC_BLUE_NOTE');
  const a=await f.chat.history(f.a.id,{query:'amber note'}),b=await f.chat.history(f.b.id,{query:'amber'});assert.equal(a.conversations.length,1);assert.equal(b.conversations.length,0);
  const conversation=await f.chat.conversation(f.a.id,first.conversationId);assert.equal(conversation.messages[0].text,'SYNTHETIC_AMBER_NOTE');assert.ok(!('storedSessionId'in conversation));assert.ok(!JSON.stringify(conversation).includes('PRIVATE_INTERNAL_VALUE'));
  const again=await f.chat.conversation(f.a.id,first.conversationId);assert.equal(again.revision,conversation.revision,'viewing unchanged history must not invalidate a confirmation');
  await assert.rejects(f.chat.conversation(f.b.id,first.conversationId),{status:404});const prompts=f.fake.prompts;await f.chat.history(f.a.id);await f.chat.usage(f.a.id,first.conversationId);assert.equal(f.fake.prompts,prompts,'history and usage must not infer');
});

test('branching, undo and deletion preserve sibling/profile history and deduplicate admission',async t=>{
  const f=await fixture(t),first=await f.send(f.a,'SYNTHETIC_FIRST_TURN');await f.send(f.a,'SYNTHETIC_SECOND_TURN');await f.send(f.b,'SYNTHETIC_OTHER_PROFILE');
  const parent=await f.chat.conversation(f.a.id,first.conversationId),requestKey=randomUUID();const branch=await f.chat.branchConversation(f.a.id,parent.id,{requestKey,revision:parent.revision});
  assert.equal((await f.chat.branchConversation(f.a.id,parent.id,{requestKey,revision:parent.revision})).conversation.id,branch.conversation.id);
  const preview=await f.chat.undoConversationPreview(f.a.id,parent.id);assert.equal(preview.message,'SYNTHETIC_SECOND_TURN');await f.chat.undoConversation(f.a.id,parent.id,preview);
  assert.equal((await f.chat.conversation(f.a.id,parent.id)).messages.length,2);assert.equal((await f.chat.conversation(f.a.id,branch.conversation.id)).messages.length,4);assert.equal((await f.chat.list(f.a.id)).tasks.length,1);
  await assert.rejects(f.chat.undoConversation(f.a.id,parent.id,preview),{status:409});
  const deletion=await f.chat.deleteConversationPreview(f.a.id,parent.id);assert.equal((await f.chat.deleteConversation(f.a.id,parent.id,deletion)).deleted,true);
  await assert.rejects(f.chat.conversation(f.a.id,parent.id),{status:404});assert.equal((await f.chat.history(f.a.id)).conversations.length,1);assert.equal((await f.chat.history(f.b.id)).conversations.length,1);
  await assert.rejects(f.chat.get(f.a.id,first.id),{code:'TASK_NOT_FOUND'});assert.equal((await f.chat.history(f.a.id,{query:'SECOND'})).conversations[0].id,branch.conversation.id);
});

test('legacy migration is profile-scoped, repeatable, keeps backups and cannot reimport a deleted conversation',async t=>{
  const legacyId=randomUUID(),messages=[{role:'user',text:'SYNTHETIC_LEGACY',createdAt:123},{role:'assistant',text:'Synthetic previous answer',createdAt:124}];let retired=0;
  const f=await fixture(t,{legacyHistoryForProfile:async()=>[{id:legacyId,messages,connected:true}],deleteLegacyHistory:async(_profile,id,hash)=>{assert.equal(id,legacyId);assert.match(hash,/^[a-f0-9]{64}$/);retired++;}});
  const staged=await f.chat.history(f.a.id);assert.equal(staged.conversations.length,1);const first=await f.chat.migrateHistory(f.a.id);assert.equal(first.imported,1);assert.equal((await f.chat.migrateHistory(f.a.id)).imported,0);assert.equal(f.fake.prompts,0);
  const row=await f.chat.conversation(f.a.id,staged.conversations[0].id);assert.deepEqual(row.messages.map(item=>item.text),messages.map(item=>item.text));assert.equal(row.canContinue,false,'unknown legacy source access remains read-only');
  const preview=await f.chat.deleteConversationPreview(f.a.id,row.id);await f.chat.deleteConversation(f.a.id,row.id,preview);assert.equal(retired,1);assert.equal((await f.chat.history(f.a.id)).conversations.length,0);assert.equal((await f.chat.migrateHistory(f.a.id)).imported,0);
  const journal=JSON.parse(await readFile(join(f.dataDir,'profiles',f.a.id,'native-history.json')));assert.equal(journal.conversations[0].status,'deleted');assert.deepEqual(journal.conversations[0].messages,[]);
});

test('stale/expired deletion receipts cannot remove a changed or foreign conversation',async t=>{
  const f=await fixture(t),first=await f.send(f.a,'SYNTHETIC_RECEIPT');const preview=await f.chat.deleteConversationPreview(f.a.id,first.conversationId);
  await f.send(f.a,'SYNTHETIC_NEWER_TURN');await assert.rejects(f.chat.deleteConversation(f.a.id,first.conversationId,preview),{status:409});await assert.rejects(f.chat.deleteConversation(f.b.id,first.conversationId,preview),{status:404});
  assert.equal((await f.chat.conversation(f.a.id,first.conversationId)).messages.length,4);
});

test('projection removes hidden/system/tool/reasoning rows and only strips exact trusted prompt envelopes',()=>{
  const message='SYNTHETIC_MESSAGE',tools=[{name:'memory_search'}],rows=[{role:'system',text:'SYSTEM_SECRET'},{role:'tool',content:'TOOL_SECRET'},{role:'assistant',text:'HIDDEN_SECRET',display_kind:'hidden'},{role:'user',text:nativePrompt(message,tools),reasoning:'PRIVATE_INTERNAL_VALUE'},{role:'assistant',text:'VISIBLE',reasoning:'PRIVATE_INTERNAL_VALUE',args:{secret:true}}];
  assert.deepEqual(projectTranscript({messages:rows},{tools,knownTurns:[{message}]}),[{role:'user',text:message},{role:'assistant',text:'VISIBLE'}]);
});

test('an interrupted undo is reconciled from the native transcript rather than repeated',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-undo-journal-')),profileId=randomUUID();t.after(()=>rm(dataDir,{recursive:true,force:true}));let clock=100;
  const options={dataDir,profileId,getProfile:async()=>({id:profileId}),now:()=>clock};let history=await createNativeHistory(options);
  const item=await history.create({scopeKey:'a'.repeat(64),messages:[{role:'user',text:'ONE'},{role:'assistant',text:'A'},{role:'user',text:'TWO'},{role:'assistant',text:'B'}]});const preview=await history.undoPreview(item.id);await history.beginUndo(item.id,preview);await history.close();history=await createNativeHistory(options);
  assert.equal((await history.get(item.id)).mutation.kind,'undo');assert.deepEqual(await history.reconcileUndo(item.id,[{role:'user',text:'ONE'},{role:'assistant',text:'A'}]),{outcome:'applied'});assert.equal((await history.get(item.id)).mutation,null);
  const deletion=await history.deletionPreview(item.id);clock+=120001;await assert.rejects(history.beginDelete(item.id,deletion),{status:409});await history.close();
});

test('lost deletion acknowledgement leaves a durable receipt and reconciles without recreating the transcript',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-history-delete-recovery-')),profile={id:randomUUID()},fake=nativeFake();let lose=true,chat;
  const options={dataDir,getProfile:async()=>profile,isDeviceActive:async()=>true,sourceRoot:resolve('fixture'),apiMode:'chat_completions',...fake,startWorker:async input=>{const worker=await fake.startWorker(input),request=worker.client.request;worker.client.request=async(method,params)=>{const result=await request(method,params);if(method==='nemo.history.delete'&&lose){lose=false;throw new Error('Synthetic response lost after deletion.');}return result;};return worker;}};
  t.after(async()=>{await chat?.close();await rm(dataDir,{recursive:true,force:true});});chat=await createNativeChat(options);
  const requestKey=randomUUID(),result=await chat.submit(profile.id,{requestKey,message:'SYNTHETIC_DELETE_RECOVERY',deviceId:'fixture'});for(let i=0;i<150&&chat.isBusy(profile.id);i++)await delay(10);const task=(await chat.get(profile.id,result.task.id)).task,preview=await chat.deleteConversationPreview(profile.id,task.conversationId);
  await assert.rejects(chat.deleteConversation(profile.id,task.conversationId,preview),{code:'HISTORY_DELETE_PENDING'});assert.equal((await chat.history(profile.id)).conversations[0].status,'deleting');await chat.close();chat=await createNativeChat(options);
  const retry=await chat.deleteConversationPreview(profile.id,task.conversationId);assert.equal((await chat.deleteConversation(profile.id,task.conversationId,retry)).deleted,true);assert.equal((await chat.history(profile.id)).conversations.length,0);
  await assert.rejects(chat.submit(profile.id,{requestKey,message:'SYNTHETIC_DELETE_RECOVERY',deviceId:'fixture'}),{code:'TASK_DELETED'});assert.equal(fake.prompts,1);
});

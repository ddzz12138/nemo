import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createFamilyServer} from '../lib/family-server.mjs';
import {createNativeChat} from '../lib/native-chat.mjs';
import {createCalendarStore} from '../lib/calendar.mjs';
import {nativeFake} from './helpers/native-fake.mjs';

async function fixture(t,{sourceGate=async()=>{},chooseTool=()=>({name:'memory_search',arguments:{query:'my favourite'}})}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-family-')),reads=[],learned=[],fake=nativeFake({toolForPrompt:(text,options)=>options.connectionTools?.length?chooseTool(text):null});
  const app=await createFamilyServer({dataDir,publicDir:resolve('public'),logger(){},provider:{status:()=>({connected:true})},
    nativeFactory:options=>createNativeChat({...options,...fake,sourceRoot:resolve('synthetic-source'),apiMode:'chat_completions'}),
    integrationsForProfile:async(profile,{dataDir})=>({calendar:await createCalendarStore({dataDir}),gmail:{async reload(){},async status(){return{connected:true}},async syncIfDue(){},async searchPage(){reads.push({profileId:profile.id,kind:'gmail'});await sourceGate();return{messages:[{id:'synthetic',subject:'Booking',snippet:'MAIL_'+profile.id}],hasMore:false};}}}),
    memoryFactory:async({profileId})=>({engine:{connected:true},gbrain:{async status(){return{connected:true}},async search(){reads.push({profileId,kind:'memory'});await sourceGate();return{items:[{slug:'nemo-notes/favourite',kind:'note',status:'active',summary:'FACT_'+profileId}],hasMore:false}}},controller:{},curation:{async configure(){},capture(input){learned.push({profileId,...input});input.onActivity?.({kind:'memory',phase:'saved',added:1});}}})
  });app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  async function request(path,identity,input){const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(identity?{Cookie:identity.cookie,'X-Nemo-Profile':identity.profile.id}:{}),...(input===undefined?{}:{'Content-Type':'application/json','X-Nemo-Request':'1'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:response.status,data:await response.json()};}
  async function pair(profile){const invite=await app.profiles.invite(profile.id),response=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},body:JSON.stringify({code:invite.code})});return{...await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]};}
  const owner=await pair(await app.profiles.owner());
  async function submit(identity,message='Synthetic favourite preference'){const result=await request('/api/native/tasks',identity,{requestKey:randomUUID(),message});assert.equal(result.status,202);return result.data.task.id;}
  async function finish(identity,id){for(let i=0;i<200;i++){const result=await request('/api/native/tasks/'+id,identity);if(!['queued','running'].includes(result.data.task?.phase))return result.data.task;await delay(5);}throw new Error('Synthetic native family task stalled.');}
  return{app,request,pair,submit,finish,owner,reads,learned,fake};
}

test('native chat uses each adult’s own Memory and Gmail, with shared saved consent and post-reply learning',async t=>{
  const f=await fixture(t,{chooseTool:text=>text.includes('email')?{name:'gmail_search',arguments:{query:'subject:booking'}}:{name:'memory_search',arguments:{query:'favourite'}}}),other=await f.pair(await f.app.profiles.create('Second adult'));
  const plain=await f.finish(f.owner,await f.submit(f.owner));assert.equal(plain.phase,'complete');assert.equal(f.reads.length,0);
  for(const identity of [f.owner,other])assert.equal((await f.request('/api/integrations/consent',identity,{enabled:true})).status,200);
  const [first,second]=await Promise.all([f.submit(f.owner).then(id=>f.finish(f.owner,id)),f.submit(other).then(id=>f.finish(other,id))]);
  assert.equal(first.phase,'complete');assert.equal(second.phase,'complete');assert.match(first.text,new RegExp('FACT_'+f.owner.profile.id));assert.ok(!first.text.includes(other.profile.id));assert.match(second.text,new RegExp('FACT_'+other.profile.id));assert.ok(!second.text.includes(f.owner.profile.id));assert.equal(first.tools,1);
  const mail=await f.finish(other,await f.submit(other,'Synthetic email booking'));assert.match(mail.text,new RegExp('MAIL_'+other.profile.id));assert.ok(!mail.text.includes(f.owner.profile.id));
  for(let i=0;i<20&&f.learned.length<4;i++)await delay(5);assert.ok(f.learned.some(entry=>entry.profileId===other.profile.id&&entry.text==='Synthetic email booking'));
  await f.request('/api/integrations/consent',f.owner,{enabled:false});
  const count=f.reads.length,after=await f.finish(f.owner,await f.submit(f.owner,'A plain question now'));assert.equal(after.phase,'complete');assert.equal(f.reads.length,count);assert.equal(after.tools,0);
  assert.equal((await f.request('/api/native/tasks/'+first.id,other)).status,404);
});

test('a child has zero native reads until a tool is granted and cannot reach ungranted sources',async t=>{
  const f=await fixture(t),child=await f.pair(await f.app.profiles.create('Learner',true)),grant=`/api/profiles/${child.profile.id}/capabilities`;
  assert.equal((await f.request('/api/integrations/consent',child,{enabled:true})).status,403);
  const plain=await f.finish(child,await f.submit(child));assert.equal(plain.tools,0);assert.equal(f.reads.length,0);assert.ok(!f.learned.some(item=>item.profileId===child.profile.id));
  await f.request(grant,f.owner,{capability:'memory',enabled:true});await f.request('/api/integrations/consent',child,{enabled:true});
  const answer=await f.finish(child,await f.submit(child));assert.equal(answer.phase,'complete');assert.equal(answer.tools,1);assert.ok(f.reads.every(item=>item.profileId===child.profile.id&&item.kind==='memory'));
  const worker=f.fake.workers.at(-1);assert.ok(worker);
  await f.request(grant,f.owner,{capability:'memory',enabled:false});assert.equal(worker.client.closed,true);
});

test('revoking Connections during native source retrieval discards late results without affecting another profile',async t=>{
  let release,entered;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const f=await fixture(t,{sourceGate:async()=>{entered();await gate;}}),other=await f.pair(await f.app.profiles.create('Second adult'));
  await f.request('/api/integrations/consent',f.owner,{enabled:true});const id=await f.submit(f.owner);await ready;
  const revoked=await f.request('/api/integrations/consent',f.owner,{enabled:false});assert.equal(revoked.status,200);release();
  const interrupted=await f.finish(f.owner,id);assert.notEqual(interrupted.phase,'complete');assert.ok(!interrupted.text.includes('FACT_'));
  const answer=await f.finish(other,await f.submit(other));assert.equal(answer.phase,'complete');assert.equal(answer.tools,0);
});

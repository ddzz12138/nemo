import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createProviderBroker } from '../lib/provider-broker.mjs';

test('shared provider grants retain identity and can be revoked independently',async t=>{
  const a={id:randomUUID()},b={id:randomUUID()};const profiles=new Map([[a.id,a],[b.id,b]]);const calls=[];
  const taskId=randomUUID();const broker=createProviderBroker({getProfile:id=>profiles.get(id),authorizeTask:input=>input.taskId===taskId,forward:async input=>{calls.push(input);return Response.json({synthetic:true});}});
  broker.server.listen(0,'127.0.0.1');await once(broker.server,'listening');t.after(()=>broker.close());const base=`http://127.0.0.1:${broker.server.address().port}`;
  const first=await broker.issue(a.id,{taskId}),second=await broker.issue(b.id,{taskId});
  const call=(token,body={messages:[]})=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await call(first)).status,200);assert.equal(calls.at(-1).profileId,a.id);
  assert.equal((await call(second)).status,200);assert.equal(calls.at(-1).profileId,b.id);
  assert.equal((await call(first,{profileId:b.id})).status,400);
  assert.equal((await call(first,{base_url:'https://other.example'})).status,400);
  broker.revoke(a.id);assert.equal((await call(first)).status,401);assert.equal((await call(second)).status,200);
  b.policyRevision=1;assert.equal((await call(second)).status,401);
  assert.ok(calls.every(call=>!Object.hasOwn(call,'token')));
});

test('provider metadata is idle-safe while inference requires a bound running task and unexpired grant',async t=>{
  const profile={id:randomUUID()},taskId=randomUUID();let active=true,time=1000;const calls=[];
  const broker=createProviderBroker({getProfile:id=>id===profile.id?profile:null,authorizeTask:input=>active&&input.taskId===taskId,now:()=>time,forward:async input=>{calls.push(input);return Response.json({ok:true});}});
  broker.server.listen(0,'127.0.0.1');await once(broker.server,'listening');t.after(()=>broker.close());const base=`http://127.0.0.1:${broker.server.address().port}`;
  const token=await broker.issue(profile.id,{ttlMs:1000});const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const post=()=>fetch(base+'/v1/responses',{method:'POST',headers,body:'{"input":[]}'});
  assert.equal((await fetch(base+'/v1/models',{headers})).status,200);
  assert.equal((await post()).status,403);assert.equal(calls.length,1);
  await broker.bind(token,taskId);assert.equal((await post()).status,200);assert.equal(calls.at(-1).taskId,taskId);
  broker.pause(token);assert.equal((await post()).status,403);await broker.bind(token,taskId);
  active=false;assert.equal((await post()).status,403);active=true;time=2001;assert.equal((await post()).status,401);
});

test('a profile changed during provider work cannot receive the late response',async t=>{
  const profile={id:randomUUID()},taskId=randomUUID();let entered,release;const admission=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const broker=createProviderBroker({getProfile:()=>profile,authorizeTask:()=>true,forward:async()=>{entered();await gate;return Response.json({text:'LATE_PRIVATE_RESPONSE'});}});
  broker.server.listen(0,'127.0.0.1');await once(broker.server,'listening');t.after(()=>broker.close());
  const token=await broker.issue(profile.id,{taskId});
  const pending=fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{"input":[]}'});
  await admission;profile.policyRevision=1;release();const response=await pending;assert.equal(response.status,401);assert.ok(!(await response.text()).includes('LATE_PRIVATE_RESPONSE'));
});

test('managed read calls bind identity to the grant and reject arbitrary tools and identity arguments',async t=>{
  const profile={id:randomUUID()},taskId=randomUUID(),calls=[];
  const broker=createProviderBroker({getProfile:id=>id===profile.id?profile:null,authorizeTask:()=>true,forward:async()=>Response.json({}),executeTool:async input=>{calls.push(input);return{synthetic:true};}});
  broker.server.listen(0,'127.0.0.1');await once(broker.server,'listening');t.after(()=>broker.close());const token=await broker.issue(profile.id,{taskId});
  const request=body=>fetch('http://127.0.0.1:'+broker.server.address().port+'/v1/nemo/tools/call',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)});
  const good={callId:randomUUID(),name:'memory_search',arguments:{query:'synthetic'}};
  for(const change of [{name:'terminal'},{profileId:randomUUID()},{callId:'forged'},{arguments:[]},{owner:'different'},{url:'https://other.example'}])assert.equal((await request({...good,...change})).status,400);
  assert.equal(calls.length,0);assert.equal((await request(good)).status,200);assert.equal(calls[0].profileId,profile.id);assert.equal(calls[0].taskId,taskId);
  broker.pause(token);assert.equal((await request({...good,callId:randomUUID()})).status,403);assert.equal(calls.length,1);
});

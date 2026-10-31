import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSessionClient, prepareNativeHome } from '../lib/native-session.mjs';

function fixture(t,options={}) {
  const input = new PassThrough(); const output = new PassThrough(); const frames = [];
  input.on('data', value => frames.push(JSON.parse(value.toString())));
  const client = new NativeSessionClient({ profileId:randomUUID(), input, output, requestTimeoutMs:100,...options });
  t.after(() => { client.close(); input.destroy(); output.destroy(); });
  const send = value => output.write(JSON.stringify({ jsonrpc:'2.0', ...value }) + '\n');
  async function session() { const pending = client.request('session.create', { idempotency_key:randomUUID() }); const id=frames.at(-1).id; send({ id, result:{ session_id:'own_session', stored_session_id:'own_stored' } }); await pending; }
  return { client, frames, send, session };
}

test('native RPC stamps the private default profile and refuses browser/model identity overrides', async t => {
  const f=fixture(t);
  for(const params of [{profile:'other'}, {profileId:randomUUID()}, {cwd:'/other'}, {model:'override'}, {_turn_author:{}}]) await assert.rejects(f.client.request('session.create',params),/identity/);
  await assert.rejects(f.client.request('cli.exec',{command:'anything'}),/not exposed/);
  await assert.rejects(f.client.request('prompt.submit',{session_id:'other',text:'x'}),/does not belong/);
  await f.session(); assert.equal(f.frames[0].params.profile,'default');
  const pending=f.client.request('prompt.submit',{session_id:'own_session',text:'Synthetic message'});
  f.send({id:f.frames.at(-1).id,result:{status:'streaming'}}); assert.equal((await pending).status,'streaming');
});

test('native events from unowned sessions never reach a profile and requests are one-shot', async t => {
  const f=fixture(t); await f.session(); const events=[]; const questions=[];
  f.client.on('activity',event=>events.push(event)); f.client.on('question',event=>questions.push(event));
  f.send({method:'event',params:{type:'text.delta',session_id:'other',payload:{text:'OTHER_PERSON'}}});
  f.send({id:'other_question',method:'approval',params:{session_id:'other',command:'OTHER_COMMAND'}});
  assert.equal(events.length,0); assert.equal(questions.length,0);
  f.send({id:'own_question',method:'approval',params:{session_id:'own_session',request_id:'action',command:'synthetic command'}});
  assert.equal(questions[0].profileId,f.client.profileId);
  assert.throws(()=>f.client.answer('own_question',{choice:'always'}),/exact action/);
  f.client.answer('own_question',{choice:'once'});
  assert.throws(()=>f.client.answer('own_question',{choice:'once'}),/already answered/);
});

test('native clarify validates question IDs and refuses secret/sudo/vault requests', async t => {
  const f=fixture(t); await f.session();
  f.send({id:'q',method:'clarify',params:{session_id:'own_session',questions:[{qid:'city',question:'Which city?'}]}});
  assert.throws(()=>f.client.answer('q',{answers:{other:'x'}}),/displayed/);
  f.client.answer('q',{answers:{city:'Synthetic City'}});
  f.send({id:'secret',method:'sudo',params:{session_id:'own_session'}});
  assert.equal(f.frames.at(-1).error.code,-32601);
});

test('RPC timeout and epoch changes never resubmit admitted work', async t => {
  const f=fixture(t);
  await assert.rejects(f.client.request('ping'),/not resubmitted/);
  assert.equal(f.frames.length,1);
  f.send({method:'event',params:{type:'gateway.ready',payload:{replay_epoch:'first'}}});
  const pending=f.client.request('ping');
  f.send({method:'event',params:{type:'gateway.ready',payload:{replay_epoch:'second'}}});
  await assert.rejects(pending,/not automatically repeated/); assert.equal(f.frames.length,2);
});

test('native homes are separate and refuse linked profile directories', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-')); t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const first=randomUUID(),second=randomUUID();
  const a=await prepareNativeHome({dataDir,profileId:first}); const b=await prepareNativeHome({dataDir,profileId:second}); assert.notEqual(a,b);
  await assert.rejects(prepareNativeHome({dataDir,profileId:'../other'}),/trusted/);
  const linked=randomUUID(); const outside=join(dataDir,'outside'); await mkdir(outside);
  await symlink(outside,join(dataDir,'profiles',linked),process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareNativeHome({dataDir,profileId:linked}),/linked/);
});

test('guarded native events require matching policy, hide reasoning and bound incomplete frames', async t => {
  const f=fixture(t); await f.session(); f.client.requireChatGuard=true; const events=[],statuses=[];
  f.client.on('activity',event=>events.push(event)); f.client.on('status',status=>statuses.push(status));
  f.send({method:'event',params:{type:'nemo.guard',payload:{version:3,stage:'startup',isolated:true,tools:[],learningPolicy:'standard-v1'}}});
  f.send({method:'event',params:{type:'nemo.status',payload:{phase:'thinking',verb:'mulling'}}});
  f.send({method:'event',params:{type:'reasoning.delta',session_id:'own_session',payload:{text:'PRIVATE_REASONING'}}});
  f.send({method:'event',params:{type:'message.complete',session_id:'own_session',payload:{text:'Visible synthetic answer',reasoning:'PRIVATE_REASONING',rendered:'HTML'}}});
  assert.equal(statuses[0].verb,'mulling'); assert.equal(events.length,1); assert.equal(events[0].payload.reasoning,undefined); assert.equal(events[0].payload.text,'Visible synthetic answer');
  f.send({method:'event',params:{type:'tool.start',session_id:'own_session',payload:{name:'unexpected'}}}); assert.equal(f.client.closed,true);
  const unbounded=fixture(t);unbounded.client.output.write('x'.repeat(2_000_001));assert.equal(unbounded.client.closed,true);
  const wrong=fixture(t);wrong.send({method:'event',params:{type:'nemo.guard',payload:{version:3,stage:'startup',isolated:true,tools:[],learningPolicy:'child-v1'}}});assert.equal(wrong.client.closed,true);
});

test('managed native reads require exact proof and discard raw tool arguments and results',async t=>{
  const name='mcp__nemo__gmail_search',f=fixture(t,{requireChatGuard:true,expectedTools:[name]}),events=[];await f.session();f.client.on('activity',event=>events.push(event));
  f.send({method:'event',params:{type:'nemo.guard',payload:{version:3,stage:'startup',isolated:true,tools:[name],learningPolicy:'standard-v1'}}});assert.equal(f.client.guardVerified,true);
  for(const type of ['tool.start','tool.complete'])f.send({method:'event',params:{type,session_id:'own_session',payload:{name,args:{query:'PRIVATE_QUERY'},result:'PRIVATE_RAW_RESULT'}}});
  assert.equal(events.length,0);assert.equal(f.client.closed,false);
  f.send({method:'event',params:{type:'tool.start',session_id:'own_session',payload:{name:'terminal'}}});assert.equal(f.client.closed,true);
  const wrong=fixture(t,{expectedTools:[name]});wrong.send({method:'event',params:{type:'nemo.guard',payload:{version:3,stage:'startup',isolated:true,tools:[],learningPolicy:'standard-v1'}}});assert.equal(wrong.client.closed,true);
});

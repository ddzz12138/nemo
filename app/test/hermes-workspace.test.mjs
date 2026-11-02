import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createProfileStore} from '../lib/profile-store.mjs';
import {createHermesWorkspace} from '../lib/hermes-workspace.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const tick=()=>new Promise(done=>setImmediate(done));
async function finishedPreparation(service){for(let i=0;i<100;i++){const state=await service.status();if(state.phase!=='preparing')return state;await delay(10);}throw new Error('Synthetic preparation did not settle.');}
async function fixture(t,{workerFailure=false}={}) {
  const root=await mkdtemp(resolve('test/.tmp-hermes-workspace-'));
  const profiles=await createProfileStore({dataDir:root,ownerName:'Synthetic workspace owner'}),owner=await profiles.owner();
  let current=await profiles.profile(owner.id),device=true,unlocks=0,brokerClosed=0,workerClosed=0,brokerOptions,workerOptions,client,closeFailure=false;
  const calls=[],answers=[];
  const create=async overrides=>createHermesWorkspace({dataDir:root,profileId:owner.id,getProfile:async()=>current,isAuthorized:async()=>device,
    pythonPath:resolve('synthetic-python.exe'),sourceRoot:resolve('synthetic-hermes'),chatgptStatus:async()=>({connected:true}),
    chatgptSession:async()=>{unlocks++;return {provider:'chatgpt',accessToken:'SYNTHETIC_PRIVATE_PROVIDER_TOKEN',model:'synthetic-model'};},
    createBroker:async options=>{brokerOptions=options;return {baseUrl:'http://127.0.0.1:12345/v1',capability:'SYNTHETIC_LOOPBACK_CAPABILITY',model:'synthetic-model',async close(){brokerClosed++;}};},
    startWorker:async options=>{
      workerOptions=options;if(workerFailure)throw new Error('SYNTHETIC PRIVATE DIAGNOSTIC');
      client=new EventEmitter();client.request=async(method,params)=>{calls.push({method,params});if(['session.create','session.resume'].includes(method))return{session_id:'workspace-live',stored_session_id:'workspace-stored',messages:method==='session.resume'?[{role:'user',content:'Earlier request'},{role:'tool',content:'HIDDEN_TOOL_OUTPUT'},{role:'assistant',content:'Earlier answer'}]:[],info:{tools:{terminal:['terminal'],skills:['skills_list','skill_view']},skills:{productivity:['native-skill']},terminal_backend:'local'}};return{status:'streaming'};};
      client.answer=(id,result)=>answers.push({id,result});return {client,async close(){workerClosed++;if(closeFailure)throw new Error('Synthetic process tree still running');client.emit('disconnected');}};
    },...overrides});
  const service=await create();
  t.after(async()=>{await service.close();assert.equal(dirname(root),resolve('test'));assert.match(root,/\.tmp-hermes-workspace-/);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {root,owner,service,create,calls,answers,get client(){return client;},get brokerOptions(){return brokerOptions;},get workerOptions(){return workerOptions;},get unlocks(){return unlocks;},get brokerClosed(){return brokerClosed;},get workerClosed(){return workerClosed;},profile(value){current=value;},device(value){device=value;},failClose(value){closeFailure=value;}};
}

test('full workspace starts explicitly with native broker, private Hermes memory and actual reported tools',async t=>{
  const f=await fixture(t);assert.equal(f.unlocks,0);assert.equal((await f.service.status()).phase,'stopped');assert.equal(f.unlocks,0);
  const ready=await f.service.start();assert.equal(ready.phase,'ready');assert.equal(ready.busy,true);assert.equal(f.service.isBusy(),true);assert.equal(f.unlocks,1);
  assert.equal(f.brokerOptions.nativeTools,true);assert.equal(await f.brokerOptions.authorize(),true);
  assert.equal(f.workerOptions.home,join(f.root,'profiles',f.owner.id,'hermes'));
  assert.equal(f.workerOptions.profile.id,f.owner.id);assert.equal(f.workerOptions.brokerGrant,'SYNTHETIC_LOOPBACK_CAPABILITY');
  assert.equal(Object.hasOwn(f.workerOptions,'accessToken'),false);
  assert.deepEqual(ready.readiness.tools,['terminal','skills_list','skill_view']);assert.equal(ready.readiness.skills[0].items[0],'native-skill');
  assert.deepEqual(f.calls[0],{method:'session.create',params:{profile:'default',source:'tui',close_on_disconnect:true}});
  assert.equal(JSON.stringify(ready).includes('SYNTHETIC_PRIVATE_PROVIDER_TOKEN'),false);
  assert.deepEqual(JSON.parse(await readFile(join(f.workerOptions.home,'nemo-profile.json'),'utf8')),{version:1,profileId:f.owner.id});
});

test('workspace preserves upstream approval choices, consumes exact request once and omits secret answers',async t=>{
  const f=await fixture(t);await f.service.start();await f.service.prompt({message:'Use the native tool.'});
  await assert.rejects(f.service.prompt({message:'Duplicate while busy'}),error=>error.code==='HERMES_WORKSPACE_BUSY');
  f.client.emit('request',{id:'approval-1',method:'approval',params:{session_id:'workspace-live',command:'echo native',choices:['once','session','always','deny'],tool_name:'terminal'}});await tick();
  assert.equal((await f.service.status()).phase,'waiting');
  await assert.rejects(f.service.respond({id:'approval-1',result:{choice:'once',all:true}}),error=>error.status===400);
  await f.service.respond({id:'approval-1',result:{choice:'session'}});assert.deepEqual(f.answers,[{id:'approval-1',result:{choice:'session'}}]);
  await assert.rejects(f.service.respond({id:'approval-1',result:{choice:'once'}}),error=>error.code==='HERMES_WORKSPACE_REQUEST');
  f.client.emit('request',{id:'secret-1',method:'secret',params:{session_id:'workspace-live',env_var:'SYNTHETIC_SERVICE_TOKEN',prompt:'Enter the test token'}});await tick();
  await f.service.respond({id:'secret-1',result:{value:'SYNTHETIC_SECRET_ANSWER'}});
  assert.equal(f.answers.at(-1).result.value,'SYNTHETIC_SECRET_ANSWER');assert.equal(JSON.stringify(await f.service.status()).includes('SYNTHETIC_SECRET_ANSWER'),false);
  f.client.emit('request',{id:'sudo-1',method:'sudo',params:{session_id:'workspace-live',command:'native command'}});await tick();await f.service.respond({id:'sudo-1',result:{value:''}});assert.equal(f.answers.at(-1).result.value,'');
  f.client.emit('event',{type:'message.complete',session_id:'workspace-live',payload:{text:'Finished.',status:'complete'}});assert.equal((await f.service.status()).phase,'ready');
});

test('clarification validates answers; native tool/subagent activity is visible without arguments or reasoning',async t=>{
  const f=await fixture(t);await f.service.start();await f.service.prompt({message:'Research a topic.'});
  f.client.emit('request',{id:'clarify-1',method:'clarify',params:{session_id:'workspace-live',questions:[{qid:'q',question:'Which topic?',choices:['A','B']}]}});await tick();
  await assert.rejects(f.service.respond({id:'clarify-1',result:{answers:{foreign:'PRIVATE'}}}),error=>error.status===400);
  await f.service.respond({id:'clarify-1',result:{answers:{q:'A'}}});
  f.client.emit('event',{type:'tool.start',session_id:'workspace-live',payload:{name:'terminal',arguments:{command:'SYNTHETIC_PRIVATE_ARGUMENT'}}});
  f.client.emit('event',{type:'subagent.started',session_id:'workspace-live',payload:{name:'Research helper'}});
  f.client.emit('event',{type:'reasoning.delta',session_id:'workspace-live',payload:{text:'SYNTHETIC_PRIVATE_REASONING'}});
  f.client.emit('event',{type:'message.complete',session_id:'child-session',payload:{text:'Child finished',status:'complete'}});
  const state=await f.service.status();assert.equal(state.phase,'running');assert.equal(state.events.length,2);assert.equal(state.events[1].name,'Research helper');assert.equal(JSON.stringify(state).includes('SYNTHETIC_PRIVATE_'),false);
  f.client.emit('event',{type:'message.delta',session_id:'workspace-live',payload:{text:'Hello'}});f.client.emit('event',{type:'message.complete',session_id:'workspace-live',payload:{text:'Hello, complete.',status:'complete'}});
  assert.equal((await f.service.status()).messages.at(-1).content,'Hello, complete.');
});

test('owner/device revocation closes worker and prevents provider continuation or late approval',async t=>{
  const f=await fixture(t);await f.service.start();f.device(false);assert.equal(await f.brokerOptions.authorize(),false);
  await assert.rejects(f.service.prompt({message:'Do not send.'}),error=>error.status===403);assert.equal(f.workerClosed,1);assert.equal(f.brokerClosed,1);assert.equal(f.service.isBusy(),false);
  f.device(true);f.profile({...f.owner,childMode:true});await assert.rejects(f.service.start(),error=>error.status===403);assert.equal(f.unlocks,1);
  f.profile({...f.owner,classification:'unclassified'});await assert.rejects(f.service.start(),error=>error.status===403);
});

test('stop cancels the process without retry and opening restores the upstream conversation',async t=>{
  const f=await fixture(t);await f.service.start();await f.service.prompt({message:'Original prompt'});await f.service.stop();assert.equal(f.service.isBusy(),false);
  const restored=await f.service.start();assert.equal(f.calls.filter(call=>call.method==='prompt.submit').length,1);assert.equal(f.calls.at(-1).method,'session.resume');assert.equal(f.calls.at(-1).params.session_id,'workspace-stored');
  assert.deepEqual(restored.messages.map(row=>row.content),['Earlier request','Earlier answer']);assert.equal(JSON.stringify(restored).includes('HIDDEN_TOOL_OUTPUT'),false);
});

test('uncertain process shutdown remains busy and can be retried without starting another agent',async t=>{
  const f=await fixture(t);await f.service.start();f.failClose(true);const stopped=await f.service.stop();assert.equal(stopped.phase,'error');assert.equal(stopped.busy,true);assert.equal(f.service.isBusy(),true);
  await assert.rejects(f.service.start(),error=>error.code==='HERMES_WORKSPACE_BUSY');assert.equal(f.unlocks,1);
  f.failClose(false);assert.equal((await f.service.stop()).phase,'stopped');assert.equal(f.service.isBusy(),false);assert.equal(f.calls.filter(call=>call.method==='prompt.submit').length,0);
});

test('workspace remains reserved until asynchronous native process cleanup actually finishes',async t=>{
  const f=await fixture(t);let finishClose,began;const begun=new Promise(done=>{began=done;});
  const service=await f.create({startWorker:async()=>{const client=new EventEmitter();client.request=async()=>({session_id:'workspace-live',info:{tools:{terminal:['terminal']}}});return{client,async close(){began();await new Promise(done=>{finishClose=done;});}};}});t.after(()=>service.close());
  await service.start();const stopping=service.stop();await begun;
  assert.equal(service.isBusy(),true);assert.equal((await service.status()).busy,true);
  await assert.rejects(service.start(),error=>error.code==='HERMES_WORKSPACE_BUSY');await assert.rejects(service.prepare(),error=>error.code==='HERMES_WORKSPACE_BUSY');
  finishClose();assert.equal((await stopping).busy,false);assert.equal(service.isBusy(),false);
});

test('revocation and host shutdown propagate an unconfirmed process stop',async t=>{
  const f=await fixture(t);await f.service.start();f.failClose(true);
  await assert.rejects(f.service.invalidate(),error=>error.code==='HERMES_WORKSPACE_STOP_UNCONFIRMED');assert.equal(f.service.isBusy(),true);
  await assert.rejects(f.service.close(),error=>error.code==='HERMES_WORKSPACE_STOP_UNCONFIRMED');assert.equal(f.service.isBusy(),true);
  f.failClose(false);await f.service.close();assert.equal(f.service.isBusy(),false);
});

test('start reserves the workspace before rechecking a pending normal reply and never unlocks credentials on busy denial',async t=>{
  const f=await fixture(t);let resolveOwner,ownerCalls=0,normalBusy=false,service;
  service=await f.create({getProfile:async()=>{ownerCalls++;if(ownerCalls===2)await new Promise(done=>{resolveOwner=done;});return f.owner;},assertIdle:async()=>{assert.equal(service.isBusy(),true,'workspace reservation exists during idle checks');if(normalBusy)throw Object.assign(new Error('A normal reply is running.'),{status:409,code:'RUN_ACTIVE'});}});
  t.after(()=>service.close());const starting=service.start();await tick();normalBusy=true;resolveOwner();
  await assert.rejects(starting,error=>error.code==='RUN_ACTIVE');assert.equal(f.unlocks,0);assert.equal(f.workerClosed,0);assert.equal(service.isBusy(),false);
  normalBusy=false;await service.start();assert.equal(f.unlocks,1);
});

test('Stop cancels a Start still awaiting its initial authorization without opening credentials',async t=>{
  const f=await fixture(t);let resolveOwner,ownerCalls=0;
  const service=await f.create({getProfile:async()=>{if(++ownerCalls===2)await new Promise(done=>{resolveOwner=done;});return f.owner;}});t.after(()=>service.close());
  const starting=service.start();await tick();assert.equal(typeof resolveOwner,'function');
  assert.equal((await service.stop()).busy,false);resolveOwner();
  await assert.rejects(starting,error=>error.code==='HERMES_WORKSPACE_UNAVAILABLE');assert.equal(f.unlocks,0);assert.equal(service.isBusy(),false);
});

test('Stop waits for a late starting worker and fences an unconfirmed late process shutdown',async t=>{
  const f=await fixture(t);let began,returnWorker,failClose=true,closeCalls=0;
  const begun=new Promise(done=>{began=done;});
  const service=await f.create({startWorker:async()=>{began();return new Promise(done=>{returnWorker=done;});}});t.after(()=>service.close());
  const starting=service.start();const rejected=assert.rejects(starting,error=>error.code==='HERMES_WORKSPACE_UNAVAILABLE');await begun;
  let stopReturned=false;const stopping=service.stop().then(state=>{stopReturned=true;return state;});await tick();assert.equal(stopReturned,false);assert.equal(service.isBusy(),true);
  returnWorker({async close(){closeCalls++;if(failClose)throw new Error('Synthetic process still running');}});
  await rejected;const stopped=await stopping;assert.equal(stopped.phase,'error');assert.equal(stopped.busy,true);assert.equal(closeCalls,1);
  await assert.rejects(service.start(),error=>error.code==='HERMES_WORKSPACE_BUSY');
  failClose=false;assert.equal((await service.stop()).busy,false);assert.equal(closeCalls,2);
});

test('uncertain native worker startup retains its cleanup retry when Stop cancels startup',async t=>{
  const f=await fixture(t);let began,rejectWorker,failClose=true;
  const begun=new Promise(done=>{began=done;});
  const service=await f.create({startWorker:async()=>{began();return new Promise((resolve,reject)=>{rejectWorker=reject;});}});t.after(()=>service.close());
  const starting=service.start();const rejected=assert.rejects(starting,error=>error.code==='HERMES_WORKSPACE_UNAVAILABLE');await begun;const stopping=service.stop();await tick();
  rejectWorker(Object.assign(new Error('Synthetic unconfirmed startup shutdown'),{stopUnconfirmed:true,async close(){if(failClose)throw new Error('Synthetic process still running');}}));
  await rejected;assert.equal((await stopping).busy,true);await assert.rejects(service.invalidate(),error=>error.code==='HERMES_WORKSPACE_STOP_UNCONFIRMED');
  failClose=false;assert.equal((await service.stop()).busy,false);
});

test('native tool preparation returns promptly, reports only safe progress and never starts a model',async t=>{
  const f=await fixture(t);let finish,options,started;const begun=new Promise(done=>{started=done;});
  const service=await f.create({prepareTools:value=>{options=value;started();return new Promise(done=>{finish=done;});}});t.after(()=>service.close());
  const first=await service.prepare();assert.equal(first.phase,'preparing');assert.equal(first.busy,true);assert.equal(f.unlocks,0);assert.equal(f.calls.length,0);
  await begun;assert.equal(options.home,join(f.root,'profiles',f.owner.id,'hermes'));options.onProgress({package:'chromium',stage:'download',done:20,total:100,secret:'PRIVATE_SETUP_DIAGNOSTIC'});
  options.onProgress({package:'arbitrary-package',stage:'download',command:'DO_NOT_RUN'});
  const progress=await service.status();assert.deepEqual(progress.preparation.progress,{package:'chromium',stage:'download',done:20,total:100});assert.equal(JSON.stringify(progress).includes('PRIVATE_SETUP_DIAGNOSTIC'),false);
  await assert.rejects(service.start(),error=>error.code==='HERMES_WORKSPACE_BUSY');
  finish({ok:true,tools:{browser:{available:true},computer:{available:true}}});
  const ready=await finishedPreparation(service);assert.equal(ready.phase,'stopped');assert.equal(ready.busy,false);assert.equal(ready.preparation.phase,'complete');assert.equal(f.unlocks,0);assert.equal(f.calls.length,0);
});

test('unsupported preparation stays explicit and Stop cancels native setup without automatic restart',async t=>{
  const f=await fixture(t);let started;const begun=new Promise(done=>{started=done;});let runs=0;
  const service=await f.create({prepareTools:async options=>{runs++;if(runs===1)return{ok:false,tools:{browser:{available:true},computer:{available:false,message:'Not supported by this system.'}}};started();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Synthetic cancelled native setup')),{once:true}));}});t.after(()=>service.close());
  await service.prepare();
  const incomplete=await finishedPreparation(service);assert.equal(incomplete.preparation.phase,'incomplete');assert.equal(incomplete.preparation.tools.computer.available,false);assert.equal(incomplete.preparation.tools.computer.message,'Not supported by this system.');
  await service.prepare();await begun;const stopped=await service.stop();assert.equal(stopped.phase,'stopped');assert.equal(stopped.busy,false);assert.equal(stopped.preparation.phase,'cancelled');assert.equal(runs,2);assert.equal(f.unlocks,0);
});

test('corrupt saved session and startup failure do not discard history or expose diagnostics',async t=>{
  const f=await fixture(t);await f.service.start();await f.service.stop();const path=join(f.workerOptions.home,'nemo-workspace-session.json');await writeFile(path,'not json');
  await assert.rejects(f.service.start(),error=>error.code==='HERMES_WORKSPACE_UNAVAILABLE');assert.equal(await readFile(path,'utf8'),'not json');assert.equal((await f.service.status()).phase,'error');assert.equal(f.service.isBusy(),false);
  const broken=await fixture(t,{workerFailure:true});await assert.rejects(broken.service.start(),error=>error.code==='HERMES_WORKSPACE_UNAVAILABLE');assert.equal(broken.brokerClosed,1);assert.equal(JSON.stringify(await broken.service.status()).includes('SYNTHETIC PRIVATE DIAGNOSTIC'),false);
});

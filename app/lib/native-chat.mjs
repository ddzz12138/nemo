import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile,mkdir,stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createTaskLedger } from './task-ledger.mjs';
import { createProviderBroker } from './provider-broker.mjs';
import { createHermesForwarder } from './hermes-forwarder.mjs';
import { startNativeChatWorker } from './native-worker.mjs';
import { verifyNativeRuntime } from './native-compatibility.mjs';
import { createExecutionSlots } from './execution-slots.mjs';
import { writeJson } from './profile-store.mjs';
import {connectionTools} from './connections.mjs';
import {publicActivity} from './activity.mjs';
import {createNativeHistory,nativePrompt,projectTranscript,plainScope} from './native-history.mjs';
import {INTERACTION_TOOLS,nativeAnswers} from './native-interactions.mjs';
import {createNativeEventJournal} from './native-events.mjs';

// Read only the saved phone-visible projection. Reviewing a child must never
// start a worker, acquire a task supervisor or put their context in a parent task.
export async function readNativeReview({dataDir,profileId,id}) {
  if(!isAbsolute(dataDir||'')||!/^[a-f0-9-]{36}$/.test(profileId||'')||id!==undefined&&!/^[a-f0-9-]{36}$/.test(id))throw new Error('A trusted review profile is required.');
  const history=await readFile(join(dataDir,'profiles',profileId,'native-history.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(history){if(history.version!==1||history.profileId!==profileId||!Array.isArray(history.conversations))throw new Error('Private History needs repair.');const rows=history.conversations.filter(row=>row.profileId===profileId&&row.status==='active');if(!id)return{conversations:rows.map(row=>({id:row.id,title:row.title,updatedAt:row.updatedAt,source:'native'}))};const item=rows.find(row=>row.id===id);if(item)return{id,source:'native',messages:projectTranscript({messages:item.messages})};}
  const saved=JSON.parse(await readFile(join(dataDir,'profiles',profileId,'native-tasks.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return JSON.stringify({version:1,profileId,tasks:[]});throw error;}));
  if(saved.version!==1||saved.profileId!==profileId||!Array.isArray(saved.tasks))throw new Error('Private preview history needs repair.');
  const tasks=saved.tasks.filter(task=>task.profileId===profileId&&!task.deleted).slice(-100).reverse();
  if(!id)return{conversations:tasks.map(task=>({id:task.id,title:task.message.slice(0,100),updatedAt:task.updatedAt,source:'native'}))};
  const task=tasks.find(task=>task.id===id);if(!task)throw Object.assign(new Error('Preview reply not found.'),{status:404,code:'HISTORY_NOT_FOUND'});
  return{id:task.id,source:'native',messages:[{role:'user',text:task.message,createdAt:task.createdAt},...(task.phase==='complete'&&task.displayText?[{role:'assistant',text:task.displayText,createdAt:task.updatedAt}]:[])]};
}

export async function configureNativePreview({dataDir,enabled,pythonPath,sourceRoot,hermesHome,apiMode,verifyRuntime=verifyNativeRuntime}){
  if(!isAbsolute(dataDir||'')||typeof enabled!=='boolean')throw new Error('Choose the private installation and whether to enable preview.');
  const settings={version:1,enabled};
  if(enabled){
    if(![pythonPath,sourceRoot,hermesHome].every(path=>typeof path==='string'&&isAbsolute(path)&&!/[\0\r\n]/.test(path))||!['chat_completions','codex_responses'].includes(apiMode))throw new Error('Configure absolute runtime paths and a supported provider protocol.');
    if(!(await stat(pythonPath)).isFile()||!(await stat(hermesHome)).isDirectory())throw new Error('The selected host runtime paths are not available.');
    const checked=await verifyRuntime({sourceRoot});if(checked?.supported!==true||checked.policy!=='chat-only')throw new Error('Native preview needs the verified compatible chat runtime.');
    Object.assign(settings,{pythonPath,sourceRoot,hermesHome,apiMode});
  }
  await mkdir(dataDir,{recursive:true,mode:0o700});await writeJson(join(dataDir,'native-preview.json'),settings);return{enabled,restartRequired:true,toolAccess:'profile-consent'};
}

export async function loadNativeSettings(dataDir) {
  let value; try { value=JSON.parse(await readFile(join(dataDir,'native-preview.json'),'utf8')); } catch(error) { if(error.code==='ENOENT')return{enabled:false};throw new Error('Native preview settings need local repair.'); }
  if(!value||value.version!==1||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['version','enabled','pythonPath','sourceRoot','hermesHome','apiMode'].includes(key)))throw new Error('Unsupported native preview settings.');
  if(value.enabled&&(![value.pythonPath,value.sourceRoot,value.hermesHome].every(path=>typeof path==='string'&&isAbsolute(path)&&!/[\0\r\n]/.test(path))||!['chat_completions','codex_responses'].includes(value.apiMode)))throw new Error('Native preview needs compatible local runtime paths and a provider protocol.');
  return value;
}

/** Native preview with fixed host-relayed reads. It preserves the existing
 * chat/history for rollback and cannot advertise powerful computer capabilities. */
export async function createNativeChat({ dataDir,getProfile,isDeviceActive=async()=>true,connectionsForProfile,legacyHistoryForProfile,deleteLegacyHistory,onReply,limits,pythonPath,sourceRoot,hermesHome,apiMode,resources=createExecutionSlots(),forward,startWorker=startNativeChatWorker,verifyRuntime=verifyNativeRuntime,now=Date.now }) {
  const runtime=await verifyRuntime({sourceRoot}),interactions=runtime.managedInteractions===true;
  forward ||= createHermesForwarder({pythonPath,sourceRoot,hermesHome});
  const contexts=new Map(),pending=new Map();let closed=false,closing=null;
  const providerFailed=input=>{if(input.method==='POST')contexts.get(input.profileId)?.jobs.get(input.taskId)?.controller.abort();};
  async function authorizedJob(profileId,taskId){
    const ctx=contexts.get(profileId),job=ctx?.jobs.get(taskId);
    if(!job||job.controller.signal.aborted||!await isDeviceActive(job.deviceId,profileId)||!await ctx.ledger.authorizeProvider(taskId))return false;
    return !connectionsForProfile||(await connectionsForProfile(profileId)).key===job.scope?.key;
  }
  async function executeTool({profileId,taskId,name,arguments:args,callId,signal}){
    const ctx=contexts.get(profileId),job=ctx?.jobs.get(taskId);
    const interaction=INTERACTION_TOOLS.includes(name);
    if(!await authorizedJob(profileId,taskId)||ctx.worker?.client.guardVerified!==true||(interaction?!interactions||Object.keys(args).length>0:!job.scope?.tools.some(tool=>tool.name===name)))throw Object.assign(new Error('This task has no permission for that tool.'),{status:403});
    if(!(await ctx.ledger.recordTool(taskId,callId)).counted)throw Object.assign(new Error('This tool call was already admitted.'),{status:409});
    await ctx.ledger.activity(taskId,{kind:'tool',name:interaction?name:'mcp__nemo__'+name,key:callId,state:'running'});
    if(interaction){job.interactionCalls||=new Map();job.interactionCalls.set(callId,name);return{admitted:true};}
    try{const result=await job.scope.execute(name,args);if(signal.aborted||!await authorizedJob(profileId,taskId))throw new Error('Tool permission changed.');await ctx.ledger.activity(taskId,{kind:'tool',name:'mcp__nemo__'+name,key:callId,state:'completed'});return result;}
    catch{await ctx.ledger.activity(taskId,{kind:'tool',name:'mcp__nemo__'+name,key:callId,state:'failed'}).catch(()=>{});throw Object.assign(new Error('The connection is unavailable or its permission changed.'),{status:403});}
  }
  const broker=createProviderBroker({getProfile,forward:async input=>{try{const response=await forward(input);if(response.status!==200)providerFailed(input);return response;}catch(error){providerFailed(input);throw error;}},executeTool,authorizeTask:({profileId,taskId})=>authorizedJob(profileId,taskId)});
  broker.server.listen(0,'127.0.0.1');await once(broker.server,'listening');
  const brokerUrl=`http://127.0.0.1:${broker.server.address().port}/v1`;
  async function profileFor(id){const profile=await getProfile(id);if(!profile||profile.id!==id||profile.disabled)throw Object.assign(new Error('This profile is not active.'),{status:403,code:'NATIVE_PROFILE'});return profile;}
  async function context(id){
    await profileFor(id);if(closed)throw new Error('Native preview is stopping.');
    if(contexts.has(id)){const existing=contexts.get(id);if(existing.stopping){await existing.invalidating;return context(id);}return existing;}if(pending.has(id))return pending.get(id);
    const creating=(async()=>{let ctx;const ledger=await createTaskLedger({dataDir,profileId:id,getProfile,now,...(limits?{limits}:{}),onCommit:()=>{if(ctx)schedulePublish(ctx);}});try{const history=await createNativeHistory({dataDir,profileId:id,getProfile,now});if(closed)throw new Error('Native preview is stopping.');let events;try{events=await createNativeEventJournal({dataDir,profileId:id});}catch{}ctx={id,ledger,history,events,eventsFailed:!events,publishing:Promise.resolve(),publishedIds:null,eventTimer:null,jobs:new Map(),tail:Promise.resolve(),retiring:Promise.resolve(),worker:null,token:null,session:null,verified:false,active:false,idleTimer:null,stopping:false};contexts.set(id,ctx);await publishCurrent(ctx).catch(()=>{ctx.eventsFailed=true;});return ctx;}catch(error){await ledger.close();throw error;}})();
    pending.set(id,creating);try{return await creating;}finally{pending.delete(id);}
  }
  function stopWorker(ctx){clearTimeout(ctx.idleTimer);broker.revoke(ctx.id);if(ctx.worker)ctx.retiring=Promise.resolve(ctx.worker.close());ctx.worker=null;ctx.token=null;ctx.session=null;ctx.conversationId=null;return ctx.retiring;}
  async function publishCurrent(ctx){
    if(!ctx.events||closed||ctx.stopping)return;
    const tasks=(await ctx.ledger.all()).slice(-20),ids=new Set(tasks.map(task=>task.id));
    if(ctx.publishedIds&&[...ctx.publishedIds].some(id=>!ids.has(id)))await ctx.events.reset();
    for(const task of tasks){const projection=view(task,ctx.jobs.get(task.id));delete projection.activeMs;await ctx.events.publish(task.id,createHash('sha256').update(JSON.stringify(projection)).digest('hex'));}
    ctx.publishedIds=ids;
  }
  function schedulePublish(ctx){if(closed||ctx.stopping||!ctx.events||ctx.eventTimer)return;ctx.eventTimer=setTimeout(()=>{ctx.eventTimer=null;ctx.publishing=ctx.publishing.then(()=>publishCurrent(ctx)).catch(()=>{ctx.eventsFailed=true;});},150);ctx.eventTimer.unref();}
  async function scopeFor(id){return connectionsForProfile?await connectionsForProfile(id):{key:plainScope(id),tools:[]};}
  async function syncHistory(ctx,scope){await ctx.history.adopt(await ctx.ledger.all(),scope);if(legacyHistoryForProfile)await ctx.history.stageLegacy(await legacyHistoryForProfile(ctx.id),scope);}
  async function workerFor(ctx,profile,signal,scope){
    await ctx.retiring;
    if(closed||ctx.stopping||signal.aborted)throw new Error('Native startup was cancelled.');
    if(ctx.worker&&ctx.scopeKey!==scope.key)await stopWorker(ctx);
    if(ctx.worker&&!ctx.worker.client.closed)return ctx.worker;
    for(const other of contexts.values())if(other!==ctx&&!other.active&&other.worker)stopWorker(other);
    ctx.token=await broker.issue(ctx.id);
    const metadata=await forward({profileId:ctx.id,taskId:null,path:'/v1/models',method:'GET',body:null,signal});
    if(metadata.status!==200)throw new Error('The host provider is not configured.');
    const models=await metadata.json();const model=models?.data?.[0]?.id;if(typeof model!=='string'||!model||model.length>200)throw new Error('The host model could not be resolved.');
    if(closed||signal.aborted||ctx.stopping)throw new Error('Native startup was cancelled.');
    ctx.scopeKey=scope.key;ctx.toolCount=scope.tools.length;
    const worker=await startWorker({dataDir,profile,pythonPath,sourceRoot,brokerUrl,brokerGrant:ctx.token,model,apiMode,signal,connectionTools:scope.tools,interactions});
    if(closed||ctx.stopping||signal.aborted){await worker.close();broker.revoke(ctx.id);throw new Error('Native startup was cancelled.');}
    ctx.worker=worker;
    await ctx.worker.client.request('client.capabilities',{server_requests:true});
    return ctx.worker;
  }
  async function sessionFor(ctx,conversation,scope,signal){
    const worker=await workerFor(ctx,await profileFor(ctx.id),signal,scope);
    if(ctx.session&&ctx.conversationId===conversation.id)return worker;
    if(ctx.session){await worker.client.request('session.close',{session_id:ctx.session.sessionId});ctx.session=null;ctx.conversationId=null;}
    let stored=conversation.storedSessionId;
    // A native create's idempotency cache is process-local. A unique persisted
    // title also reconciles a seeded import when its acknowledgement was lost.
    if(!stored){const result=await worker.client.request('session.list',{title:'nemo:'+conversation.id,limit:2});const rows=result.sessions||[];if(rows.length>1)throw Object.assign(new Error('History import needs reconciliation.'),{status:409});if(rows.length===1){stored=rows[0].id;await ctx.history.bind(conversation.id,stored);}}
    let session;
    if(stored){worker.client.registerStoredSession({profileId:ctx.id,sessionId:stored});const target=await worker.client.request('nemo.history.targets',{session_id:stored});const resume=target.resume_id||stored;worker.client.registerStoredSession({profileId:ctx.id,sessionId:resume});session=await worker.client.request('session.resume',{session_id:resume,lazy:true,omit_messages:true,inline_images:false});}
    else{session=await worker.client.request('session.create',{idempotency_key:conversation.id,title:'nemo:'+conversation.id,...(conversation.messages.length?{messages:conversation.messages.map(row=>({role:row.role,content:row.text}))}:{})});await ctx.history.bind(conversation.id,session.stored_session_id);}
    ctx.session={sessionId:session.session_id,storedSessionId:session.stored_session_id||stored};ctx.conversationId=conversation.id;return worker;
  }
  async function refreshTranscript(ctx,conversation,scope){
    const worker=await sessionFor(ctx,conversation,scope,new AbortController().signal),result=await worker.client.request('session.history',{session_id:ctx.session.sessionId});
    const turns=(await ctx.ledger.all()).filter(task=>task.conversationId===conversation.id||task.nativeSession?.storedSessionId===ctx.session.storedSessionId||task.nativeSession?.storedSessionId===conversation.storedSessionId);
    const messages=projectTranscript(result,{knownTurns:turns,tools:conversation.tools.map(name=>({name}))});
    if(conversation.mutation){const outcome=await ctx.history.reconcileUndo(conversation.id,messages);if(outcome.outcome==='applied')await ctx.ledger.forgetLastTurn(conversation.id);return ctx.history.get(conversation.id);}
    return ctx.history.cache(conversation.id,messages);
  }
  function idleOperation(ctx,operation){if(ctx.jobs.size||ctx.stopping)throw Object.assign(new Error('Wait for active replies before changing or opening History.'),{status:409,code:'RUN_ACTIVE'});const next=ctx.tail.catch(()=>{}).then(async()=>{if(ctx.jobs.size||ctx.stopping)throw Object.assign(new Error('Wait for active replies before changing or opening History.'),{status:409,code:'RUN_ACTIVE'});clearTimeout(ctx.idleTimer);try{return await operation();}finally{if(ctx.worker&&!ctx.stopping&&!ctx.jobs.size){ctx.idleTimer=setTimeout(()=>stopWorker(ctx),60000);ctx.idleTimer.unref();}}});ctx.tail=next.catch(()=>{});return next;}
  async function nativeTurn(ctx,job,task){
    await syncHistory(ctx,job.scope);
    const conversation=task.conversationId?await ctx.history.get(task.conversationId):await ctx.history.latest(job.scope.key)||await ctx.history.create({title:task.message,scopeKey:job.scope.key,tools:job.scope.tools});
    if(conversation.status!=='active'||conversation.readOnly||conversation.scopeKey!==job.scope.key||conversation.mutation)throw Object.assign(new Error('This conversation needs review or belongs to an earlier Connections permission. Start a new conversation.'),{status:409});
    const worker=await sessionFor(ctx,conversation,job.scope,job.controller.signal);job.conversationId=conversation.id;
    await ctx.ledger.bindSession(task.id,{...ctx.session,conversationId:conversation.id,scopeKey:job.scope.key});await broker.bind(ctx.token,task.id);
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,text)=>{if(done)return;done=true;worker.client.off('activity',activity);worker.client.off('status',status);worker.client.off('question',question);worker.client.off('interaction',interaction);worker.client.off('disconnected',disconnect);job.controller.signal.removeEventListener('abort',abort);error?reject(error):resolve(text);};
      const disconnect=()=>finish(new Error('Native worker disconnected. This message was not resubmitted.'));
      const abort=()=>{finish(new Error('Native work interrupted.'));worker.close();};
      const status=value=>{job.verb=value.phase==='thinking'?value.verb:'working';void ctx.ledger.activity(job.id,{kind:'thinking',verb:job.verb,state:value.phase==='thinking'?'running':'completed'}).catch(()=>{});};
      const interaction=value=>{if(job.interactionCalls?.get(value.callId)!==value.name)return job.controller.abort();job.interactionCalls.delete(value.callId);void ctx.ledger.activity(job.id,{kind:'tool',name:value.name,key:value.callId,state:value.state}).catch(()=>job.controller.abort());};
      const question=value=>{void(async()=>{if(!interactions||value.method!=='clarify'||value.params?.session_id!==ctx.session.sessionId||![...(job.interactionCalls?.values()||[])].includes('clarify')||!await authorizedJob(ctx.id,job.id))throw new Error('Unapproved native question.');const admitted=await ctx.ledger.ask(job.id,value.params.questions);job.question={id:admitted.id,nativeId:value.id,questions:admitted.questions};job.release?.();job.release=null;})().catch(()=>job.controller.abort());};
      const activity=event=>{
        if(event.sessionId!==ctx.session.sessionId)return;
        if(event.type==='todo.updated'){void ctx.ledger.plan(job.id,event.payload).catch(()=>job.controller.abort());return;}
        if(event.type==='message.delta'&&typeof event.payload.text==='string'){job.text+=event.payload.text;if(Buffer.byteLength(job.text)>200_000)job.controller.abort();else schedulePublish(ctx);}
        if(event.type==='error')finish(new Error('Hermes could not complete this native reply.'));
        if(event.type==='message.complete'){if(worker.client.guardVerified!==true||event.payload.status!=='complete'||typeof event.payload.text!=='string'||!event.payload.text.trim()||Buffer.byteLength(event.payload.text)>200_000)finish(new Error('Hermes did not return a complete guarded native answer.'));else finish(null,event.payload.text);}
      };
      worker.client.on('activity',activity);worker.client.on('status',status);worker.client.on('question',question);worker.client.on('interaction',interaction);worker.client.once('disconnected',disconnect);job.controller.signal.addEventListener('abort',abort,{once:true});
      if(job.controller.signal.aborted)return abort();
      // Never expose the native slash-command dispatcher to phone prompt text.
      worker.client.request('prompt.submit',{session_id:ctx.session.sessionId,text:nativePrompt(task.message,job.scope.tools),queued:true}).then(result=>{if(!['streaming','queued'].includes(result.status))finish(new Error('Native prompt admission was not confirmed.'));},finish);
    });
  }
  async function run(ctx,job){
    let release,timer;
    try{
      release=await resources.acquire({kind:'cloud',signal:job.controller.signal});job.release=release;
      if(!await isDeviceActive(job.deviceId,ctx.id))throw new Error('The originating device was signed out.');
      const task=await ctx.ledger.start(job.id);ctx.active=true;clearTimeout(ctx.idleTimer);
      job.scope=await scopeFor(ctx.id);
      if(!Array.isArray(job.scope.tools)||job.scope.tools.some(tool=>!connectionTools.some(known=>JSON.stringify(known)===JSON.stringify(tool)))||new Set(job.scope.tools.map(tool=>tool.name)).size!==job.scope.tools.length||connectionsForProfile&&!/^[a-f0-9]{64}$/.test(job.scope.key||''))throw new Error('Native connection scope is invalid.');
      await ctx.ledger.activity(job.id,{kind:'run',state:'running'});
      let checking=false;
      timer=setInterval(async()=>{if(checking)return;checking=true;try{if(job.question&&(await ctx.ledger.expireQuestion(job.id)).expired)job.controller.abort();else await ctx.ledger.checkpoint(job.id);}catch{job.controller.abort();}finally{checking=false;}},1000);timer.unref();
      const text=await nativeTurn(ctx,job,task);ctx.verified=true;await ctx.ledger.finish(job.id,{text});await ctx.ledger.activity(job.id,{kind:'run',state:'completed'});try{await refreshTranscript(ctx,await ctx.history.get(job.conversationId),job.scope);}catch{await ctx.history.stale(job.conversationId).catch(()=>{});}job.completed=true;
    }catch{ctx.verified=false;try{await ctx.ledger.checkpoint(job.id).catch(()=>{});await ctx.ledger.interrupt(job.id,'worker');await ctx.ledger.activity(job.id,{kind:'run',state:'failed'});}catch{}stopWorker(ctx);}
    finally{clearInterval(timer);ctx.active=false;if(ctx.token)broker.pause(ctx.token);job.release?.();job.release=null;ctx.jobs.delete(job.id);if(job.completed&&!ctx.stopping&&onReply){void ctx.ledger.get(job.id).then(task=>onReply({profileId:ctx.id,id:job.id,text:task.message,onActivity:event=>{void ctx.ledger.activity(job.id,event).catch(()=>{});}})).catch(()=>{});}if(ctx.worker){ctx.idleTimer=setTimeout(()=>stopWorker(ctx),60_000);ctx.idleTimer.unref();}}
  }
  const questionView=question=>({id:question.id,questions:question.questions,state:question.state,expiresAt:question.expiresAt,...(question.state==='answered'?{answers:question.answers}:{})});
  const view=(task,job)=>({id:task.id,conversationId:task.conversationId||job?.conversationId||null,phase:task.phase,reason:task.reason,message:task.message,text:task.phase==='complete'?task.displayText||'':['running','waiting'].includes(task.phase)?job?.text||'':'',verb:job?.verb||'working',createdAt:task.createdAt,activeMs:task.activeMs,preview:true,tools:task.toolCalls.length,activity:publicActivity(task.activity),...(task.plan?{plan:task.plan}:{}),...(task.question?{question:questionView(task.question)}:{}),...(task.questionHistory?.length?{questionHistory:task.questionHistory.map(questionView)}:{})});
  const conversationView=(conversation,scope)=>({id:conversation.id,source:'native',title:conversation.title,count:conversation.messages.length,revision:conversation.revision,status:conversation.status,imported:!!conversation.legacyId,messages:conversation.messages,stale:conversation.stale===true,needsReconciliation:!!conversation.mutation,canContinue:conversation.status==='active'&&!conversation.readOnly&&!conversation.mutation&&conversation.scopeKey===scope.key,readOnlyReason:conversation.readOnly||conversation.scopeKey!==scope.key?'This earlier conversation used a different Connections permission. You can read it here and start a new chat with your current permission.':null});
  return {
    status(profileId){return{available:!closed,verified:contexts.get(profileId)?.verified===true,preview:true,tools:contexts.get(profileId)?.toolCount||0,connectionsSupported:!!connectionsForProfile,interactionsSupported:interactions};},
    async answer(profileId,id,{questionId,answers,deviceId}){const ctx=await context(profileId),task=await ctx.ledger.get(id);if(!await isDeviceActive(deviceId,profileId))throw Object.assign(new Error('This device was signed out.'),{status:401});const question=[task.question,...(task.questionHistory||[])].find(item=>item?.id===questionId);if(!question)throw Object.assign(new Error('This question is no longer available.'),{status:409});const clean=nativeAnswers(question.questions,answers);if(question.state==='answered')return ctx.ledger.answer(id,questionId,clean);const job=ctx.jobs.get(id);if(!job||job.question?.id!==questionId||job.controller.signal.aborted||job.answering)throw Object.assign(new Error('This question expired or is already being answered.'),{status:409});job.answering=true;let admitted=false;try{const result=await ctx.ledger.answer(id,questionId,clean,{defer:true});if(!result.answered)return result;admitted=true;job.release=await resources.acquire({kind:'cloud',signal:job.controller.signal});if(!await isDeviceActive(deviceId,profileId))throw new Error('Device authorization changed.');await ctx.ledger.continueAfterAnswer(id,questionId);ctx.worker.client.answer(job.question.nativeId,{answers:result.answers});job.question=null;return{answered:true};}catch(error){if(admitted)job.controller.abort();else{job.release?.();job.release=null;}throw error;}finally{job.answering=false;}},
    isBusy(profileId){const ctx=contexts.get(profileId);return !!ctx&&(ctx.active||ctx.jobs.size>0);},
    async submit(profileId,{requestKey,message,deviceId,conversationId}){const ctx=await context(profileId);if(!await isDeviceActive(deviceId,profileId))throw Object.assign(new Error('This device was signed out.'),{status:401});if(conversationId)await ctx.history.get(conversationId);const result=await ctx.ledger.create({requestKey,message,conversationId});if(result.created){const job={id:result.task.id,deviceId,controller:new AbortController(),text:'',verb:'working'};ctx.jobs.set(job.id,job);ctx.tail=ctx.tail.catch(()=>{}).then(()=>run(ctx,job));}return{task:view(result.task,ctx.jobs.get(result.task.id)),created:result.created};},
    async history(profileId,{query=''}={}){const ctx=await context(profileId),scope=await scopeFor(profileId);if(!ctx.jobs.size)await syncHistory(ctx,scope);return{conversations:await ctx.history.list({query}),nativeAuthority:true};},
    async conversation(profileId,id){const ctx=await context(profileId),scope=await scopeFor(profileId);return idleOperation(ctx,async()=>{await syncHistory(ctx,scope);let conversation=await ctx.history.get(id);if(conversation.status==='active')try{conversation=await refreshTranscript(ctx,conversation,scope);}catch{await ctx.history.stale(id).catch(()=>{});conversation=await ctx.history.get(id);}return conversationView(conversation,scope);});},
    async newConversation(profileId){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId);return{conversation:conversationView(await ctx.history.create({scopeKey:scope.key,tools:scope.tools}),scope)};});},
    async migrateHistory(profileId){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId);await syncHistory(ctx,scope);let imported=0;for(const row of(await ctx.history.list()).filter(row=>row.imported&&!row.stored&&row.status==='active').slice(0,20)){await refreshTranscript(ctx,await ctx.history.get(row.id),scope);imported++;}return{imported,remaining:(await ctx.history.list()).filter(row=>row.imported&&!row.stored&&row.status==='active').length,backupsRetained:true};});},
    async renameConversation(profileId,id,input){const ctx=await context(profileId);return ctx.history.rename(id,input);},
    async deleteConversationPreview(profileId,id){const ctx=await context(profileId);return idleOperation(ctx,async()=>{let item=await ctx.history.get(id),targets=item.deletionTargets||[];if(item.status==='active'){const scope=await scopeFor(profileId);if(!item.storedSessionId){await sessionFor(ctx,item,scope,new AbortController().signal);item=await ctx.history.get(id);}else await workerFor(ctx,await profileFor(profileId),new AbortController().signal,scope);ctx.worker.client.registerStoredSession({profileId,sessionId:item.storedSessionId});targets=(await ctx.worker.client.request('nemo.history.targets',{session_id:item.storedSessionId})).targets;if(!Array.isArray(targets))throw new Error('Private transcript deletion needs recovery.');}return ctx.history.deletionPreview(id,targets);});},
    async deleteConversation(profileId,id,input){const ctx=await context(profileId);return idleOperation(ctx,async()=>{
      const item=await ctx.history.beginDelete(id,input),scope=await scopeFor(profileId);
      try{if(item.storedSessionId){const worker=await workerFor(ctx,await profileFor(profileId),new AbortController().signal,scope);if(ctx.session){await worker.client.request('session.close',{session_id:ctx.session.sessionId});ctx.session=null;ctx.conversationId=null;}worker.client.registerStoredSession({profileId,sessionId:item.storedSessionId});const result=await worker.client.request('nemo.history.delete',{session_id:item.storedSessionId,targets:item.deletionTargets});if(result.deleted!==true||result.files_removed!==true)throw new Error('Native deletion incomplete.');}
        if(item.legacyId&&deleteLegacyHistory)await deleteLegacyHistory(profileId,item.legacyId,item.legacyContentHash);await ctx.ledger.forgetConversation(id,item.storedSessionId);return await ctx.history.finishDelete(id);
      }catch{throw Object.assign(new Error('Deletion is incomplete. Refresh History and review this deletion again; the conversation will not be used for new work.'),{status:409,code:'HISTORY_DELETE_PENDING'});}
    });},
    async undoConversationPreview(profileId,id){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId),item=await refreshTranscript(ctx,await ctx.history.get(id),scope);if(item.readOnly||item.scopeKey!==scope.key)throw Object.assign(new Error('This earlier conversation is read-only.'),{status:409});return ctx.history.undoPreview(id);});},
    async undoConversation(profileId,id,input){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId),item=await ctx.history.get(id);if(item.readOnly||item.scopeKey!==scope.key)throw Object.assign(new Error('This earlier conversation is read-only.'),{status:409});const admitted=await ctx.history.beginUndo(id,input);try{await sessionFor(ctx,admitted,scope,new AbortController().signal);await ctx.worker.client.request('session.undo',{session_id:ctx.session.sessionId,intent:'undo'});const result=await refreshTranscript(ctx,admitted,scope);if(result.mutation)throw new Error();return{ok:true,conversation:conversationView(result,scope)};}catch{throw Object.assign(new Error('Undo needs reconciliation. Refresh the conversation before taking another action; it was not repeated.'),{status:409,code:'HISTORY_UNDO_PENDING'});}});},
    async branchConversation(profileId,id,input){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId),parent=await ctx.history.get(id);if(parent.readOnly||parent.scopeKey!==scope.key)throw Object.assign(new Error('This earlier conversation is read-only.'),{status:409});const child=await ctx.history.branchDraft(id,input);if(!child.storedSessionId){const worker=await sessionFor(ctx,parent,scope,new AbortController().signal),known=await worker.client.request('session.list',{title:'nemo:'+child.id,limit:2});if((known.sessions||[]).length>1)throw Object.assign(new Error('This branch needs reconciliation.'),{status:409});let session;if(known.sessions?.length){await ctx.history.bind(child.id,known.sessions[0].id);}else{session=await worker.client.request('session.branch',{session_id:ctx.session.sessionId,name:'nemo:'+child.id,idempotency_key:child.id});await ctx.history.bind(child.id,session.stored_session_id);}}return{conversation:conversationView(await refreshTranscript(ctx,await ctx.history.get(child.id),scope),scope)};});},
    async usage(profileId,id){const ctx=await context(profileId);return idleOperation(ctx,async()=>{const scope=await scopeFor(profileId);await sessionFor(ctx,await ctx.history.get(id),scope,new AbortController().signal);const value=await ctx.worker.client.request('session.usage',{session_id:ctx.session.sessionId});return Object.fromEntries(Object.entries(value).filter(([key,item])=>['prompt','completion','total','calls','context_used','context_max','cost_usd'].includes(key)&&typeof item==='number'&&Number.isFinite(item)&&item>=0));});},
    async list(profileId){const ctx=await context(profileId);const summaries=await ctx.ledger.list();return{tasks:await Promise.all(summaries.slice(0,20).map(async item=>view(await ctx.ledger.get(item.id),ctx.jobs.get(item.id))))};},
    async get(profileId,id){const ctx=await context(profileId);return{task:view(await ctx.ledger.get(id),ctx.jobs.get(id))};},
    async changes(profileId,after){const ctx=await context(profileId);await ctx.publishing;if(ctx.eventsFailed||!ctx.events)throw Object.assign(new Error('Live updates are unavailable. Reconnect to read saved tasks.'),{status:503,code:'NATIVE_EVENTS'});return ctx.events.read(after);},
    async stop(profileId,id){const ctx=await context(profileId);await ctx.ledger.cancel(id);ctx.jobs.get(id)?.controller.abort();return{ok:true};},
    async extend(profileId,id,{deviceId}){const ctx=await context(profileId);if(!await isDeviceActive(deviceId,profileId))throw Object.assign(new Error('This device was signed out.'),{status:401});const task=await ctx.ledger.get(id);if(task.phase!=='paused'||task.reason!=='budget')throw Object.assign(new Error('Only a task paused at its budget can be extended.'),{status:409});await ctx.ledger.resume(id,{extend:true});const job={id,deviceId,controller:new AbortController(),text:'',verb:'working'};ctx.jobs.set(id,job);ctx.tail=ctx.tail.catch(()=>{}).then(()=>run(ctx,job));return{ok:true};},
    async cancelDevice(profileId,deviceId){const ctx=contexts.get(profileId);if(!ctx)return;for(const job of ctx.jobs.values())if(job.deviceId===deviceId){await ctx.ledger.cancel(job.id);job.controller.abort();}},
    async invalidate(profileId){const ctx=contexts.get(profileId);if(!ctx)return;if(ctx.invalidating)return ctx.invalidating;ctx.stopping=true;clearTimeout(ctx.eventTimer);ctx.invalidating=(async()=>{for(const job of ctx.jobs.values())job.controller.abort();await stopWorker(ctx);await ctx.tail;await ctx.publishing;await ctx.events?.close();await ctx.history.close();await ctx.ledger.close();if(contexts.get(profileId)===ctx)contexts.delete(profileId);})();return ctx.invalidating;},
    close(){if(closing)return closing;closed=true;closing=(async()=>{await Promise.allSettled([...pending.values()]);for(const ctx of contexts.values()){ctx.stopping=true;clearTimeout(ctx.eventTimer);for(const job of ctx.jobs.values())job.controller.abort();stopWorker(ctx);}try{const results=await Promise.allSettled([...contexts.values()].map(async ctx=>{await ctx.tail;await ctx.retiring;await ctx.publishing;await ctx.events?.close();await ctx.history.close();await ctx.ledger.close();}));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}finally{await broker.close();}})();return closing;},
  };
}

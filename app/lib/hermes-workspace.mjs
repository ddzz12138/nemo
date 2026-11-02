import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createChatGPTPlanBroker } from './chatgpt-plan-broker.mjs';
import { prepareHermesWorkspace } from './hermes-memory.mjs';
import { writeJson } from './profile-store.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUESTS = new Set(['approval', 'clarify', 'secret', 'sudo']);
const unavailable = () => Object.assign(new Error('Hermes workspace could not complete this step. Stop it and try again.'), {status:503, code:'HERMES_WORKSPACE_UNAVAILABLE'});
const denied = () => Object.assign(new Error('Hermes workspace is available only to the owner on this PC.'), {status:403, code:'HERMES_WORKSPACE_OWNER'});
const inputError = () => Object.assign(new Error('Use the controls shown in Hermes workspace.'), {status:400, code:'HERMES_WORKSPACE_INPUT'});
const stopUnconfirmed = () => Object.assign(new Error('Some running Hermes work could not be confirmed stopped.'), {status:503,code:'HERMES_WORKSPACE_STOP_UNCONFIRMED'});
const text = (value, maximum = 4000) => typeof value === 'string' ? value.slice(0, maximum) : '';
const clone = value => JSON.parse(JSON.stringify(value));
const keysOnly = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key));
const sessionId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && value!=='latest';
async function savedSession(home,profileId) {
  const path=join(home,'nemo-workspace-session.json');let info;
  try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw unavailable();}
  if(info.isSymbolicLink()||!info.isFile()||info.nlink>1||info.size>2048)throw unavailable();
  const saved=JSON.parse(await readFile(path,'utf8'));
  if(!keysOnly(saved,['version','profileId','sessionId'])||saved.version!==1||saved.profileId!==profileId||!sessionId(saved.sessionId))throw unavailable();
  return saved.sessionId;
}
function restoredMessages(rows) {
  return (Array.isArray(rows)?rows:[]).filter(row=>['user','assistant'].includes(row?.role)).slice(-60).map(row=>({id:randomUUID(),role:row.role,content:text(row.content??row.text,200000),streaming:false})).filter(row=>row.content);
}

// This projection is presentation only. Hermes owns its availability checks,
// tool implementations, skills, prompt execution and approval queue.
function readiness(info = {}) {
  function groups(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value).slice(0,128).map(([name, entries])=>({name:text(name,120), items:(Array.isArray(entries)?entries:[]).slice(0,256).map(item=>text(typeof item==='string'?item:item?.name,160)).filter(Boolean)}));
  }
  const toolsets = groups(info.tools), skills = groups(info.skills);
  return {checked:toolsets.length>0 || skills.length>0, toolsets, skills, tools:toolsets.flatMap(group=>group.items),
    terminalBackend:text(info.terminal_backend,80), approvalMode:text(info.approval_mode,80)};
}

function requestView(request) {
  if (!request || typeof request.id !== 'string' || request.id.length>200 || !REQUESTS.has(request.method) || !keysOnly(request.params || {}, Object.keys(request.params || {}))) throw inputError();
  const source=request.params || {}, params={};
  if (request.method==='approval') {
    params.command=text(source.command,16000); params.description=text(source.description,4000); params.tool_name=text(source.tool_name,120);
    params.choices=(Array.isArray(source.choices)?source.choices:[]).filter(value=>['once','session','always','deny'].includes(value));
    if (!params.choices.length) throw inputError();
  } else if(request.method==='clarify') {
    if(!Array.isArray(source.questions)||!source.questions.length||source.questions.length>8)throw inputError();
    params.questions=source.questions.map(question=>{
      if(!question||typeof question.qid!=='string'||!question.qid||question.qid.length>200||typeof question.question!=='string')throw inputError();
      return {qid:question.qid, question:text(question.question,8000), multi_select:question.multi_select===true,
        choices:Array.isArray(question.choices)?question.choices.slice(0,32).map(value=>text(value,2000)):null};
    });
  } else if(request.method==='secret') {
    params.env_var=text(source.env_var,200); params.prompt=text(source.prompt,4000);
  } else params.command=text(source.command,16000);
  return {id:request.id, method:request.method, params};
}

function responseFor(request, result) {
  if(request.method==='approval') {
    if(!keysOnly(result,['choice'])||!request.params.choices.includes(result.choice))throw inputError();
    return {choice:result.choice};
  }
  if(request.method==='clarify') {
    if(!keysOnly(result,['answers'])||!result.answers||typeof result.answers!=='object'||Array.isArray(result.answers))throw inputError();
    const ids=new Set(request.params.questions.map(question=>question.qid));
    if(Object.entries(result.answers).some(([key,value])=>!ids.has(key)||(value!==null&&(typeof value!=='string'||value.length>8000))))throw inputError();
    return {answers:result.answers};
  }
  if(!keysOnly(result,['value'])||typeof result.value!=='string'||result.value.length>16000)throw inputError();
  return {value:result.value};
}

/** Host-only, explicit owner workspace. Never used for child/family chat.
 * The upstream worker has the owner's OS access; this is not a profile sandbox.
 * Credentials and submitted secret values never become snapshot/event fields. */
export async function createHermesWorkspace({dataDir,profileId,getProfile,pythonPath,sourceRoot,chatgptSession,chatgptStatus=async()=>({connected:false}),isAuthorized=async()=>true,assertIdle=async()=>{},
  startWorker=options=>import('./hermes-workspace-worker.mjs').then(module=>module.startHermesWorkspaceWorker(options)),
  prepareTools=options=>import('./hermes-workspace-prepare.mjs').then(module=>module.prepareHermesWorkspaceTools(options)),
  createBroker=createChatGPTPlanBroker, prepareWorkspace=prepareHermesWorkspace, now=Date.now}={}) {
  if(!isAbsolute(dataDir||'')||!UUID.test(profileId||'')||typeof getProfile!=='function'||typeof chatgptSession!=='function'||typeof isAuthorized!=='function'||typeof assertIdle!=='function')throw denied();
  let worker=null, lingeringWorker=null, broker=null, controller=null, currentSession=null, closed=false, generation=0, cancellation=0, starting=null, preparing=null, lingeringPreparation=null, stopping=null, guardTimer=null;
  let phase='stopped', problem='', version=0, messages=[], events=[], requests=new Map(), available=readiness(), preparation=null;
  const update=()=>version++;
  async function owner(){const profile=await getProfile(profileId);if(closed||!profile||profile.id!==profileId||profile.disabled||profile.role!=='owner'||profile.childMode===true||['child','unclassified'].includes(profile.classification)||await isAuthorized()!==true)throw denied();return profile;}
  function snapshot(){return {ok:true,sourcePreview:true,ownerOnly:true,profileId,phase,version,message:problem,
    busy:!!worker||!!lingeringWorker||!!starting||!!preparing||!!lingeringPreparation||!!stopping,runtimeConfigured:isAbsolute(pythonPath||'')&&isAbsolute(sourceRoot||''),readiness:clone(available),preparation:clone(preparation),
    messages:clone(messages),events:clone(events),requests:clone([...requests.values()])};}
  function record(type,name='',state='') {events.push({id:randomUUID(),type:text(type,100),name:text(name,160),state:text(state,100),at:now()});events=events.slice(-80);update();}
  async function dispose(nextPhase='stopped',{waitForStart=true}={}) {
    if(stopping)return stopping;
    const cleanup=(async()=>{
    generation++;cancellation++; const oldWorker=worker||lingeringWorker,oldBroker=broker,oldPreparation=preparing||lingeringPreparation,oldStart=waitForStart?starting:null;worker=null;lingeringWorker=null;broker=null;currentSession=null;
    controller?.abort();controller=null;clearInterval(guardTimer);guardTimer=null;requests.clear();phase=nextPhase;update();
    // A native process may still be starting when Stop arrives. Its factory
    // must settle and confirm cleanup before Stop can report its final state.
    // Startup's own failure cleanup skips this wait to avoid awaiting itself.
    const results=await Promise.allSettled([Promise.resolve().then(()=>oldWorker?.close()),Promise.resolve().then(()=>oldBroker?.close()),oldPreparation,oldStart]);
    if(results[0].status==='rejected'){lingeringWorker=oldWorker;phase='error';problem='Some running Hermes work could not be confirmed stopped. Try Stop Hermes again before continuing.';update();}
    if(results[2].status==='rejected'){lingeringPreparation=oldPreparation;phase='error';problem='The tool setup could not be confirmed stopped. Quit Nemo before continuing.';update();}
    else if(oldPreparation&&preparation?.phase==='preparing'){preparation={phase:'cancelled',progress:null,tools:null};update();}
    })();
    stopping=cleanup;
    try{await cleanup;}finally{if(stopping===cleanup)stopping=null;update();}
  }
  async function ensureOwner(){try{return await owner();}catch(error){await dispose();throw error;}}
  function attach(activeWorker,ticket) {
    const active=()=>!closed&&ticket===generation&&worker===activeWorker;
    activeWorker.client.on('event',event=>{
      if(!active()||!event||typeof event.type!=='string')return;
      const payload=event.payload||{};
      if(currentSession&&event.session_id&&event.session_id!==currentSession&&(/^(?:message\.|session\.info$)/.test(event.type)))return;
      if(event.type==='session.info'){available=readiness(payload);update();return;}
      if(event.type==='request.cancel'){requests.delete(payload.id||payload.request_id);if(!requests.size&&phase==='waiting')phase='running';update();return;}
      if(event.type==='message.start'){phase='running';update();return;}
      if(event.type==='message.delta'&&typeof payload.text==='string'){
        const last=messages.at(-1);
        if(last?.role==='assistant'&&last.streaming){last.content=(last.content+payload.text).slice(0,200000);}else messages.push({id:randomUUID(),role:'assistant',content:text(payload.text,200000),streaming:true});
        messages=messages.slice(-60);update();return;
      }
      if(event.type==='message.interim'&&typeof payload.text==='string'){
        const last=messages.at(-1);if(last?.role==='assistant'&&last.streaming){last.content=text(payload.text,200000);last.streaming=false;}else messages.push({id:randomUUID(),role:'assistant',content:text(payload.text,200000),streaming:false});update();return;
      }
      if(event.type==='message.complete') {
        const last=messages.at(-1);if(typeof payload.text==='string'&&payload.text.trim()){
          if(last?.role==='assistant'&&last.streaming){last.content=text(payload.text,200000);last.streaming=false;}
          else messages.push({id:randomUUID(),role:'assistant',content:text(payload.text,200000),streaming:false});
        }else if(last?.streaming)last.streaming=false;
        requests.clear();phase=payload.status==='complete'?'ready':'error';problem=phase==='error'?'Hermes did not finish this reply. Review the conversation before trying again.':'';messages=messages.slice(-60);update();return;
      }
      if(/^(tool\.|subagent\.|agent\.)/.test(event.type)){record(event.type,payload.name||payload.tool_name||payload.agent_name,payload.status||payload.state);return;}
      if(event.type==='error'){phase='error';problem='Hermes reported a problem. Review the conversation before trying again.';record('error');}
    });
    activeWorker.client.on('request',request=>{
      if(!active())return;
      void ensureOwner().then(()=>{if(!active())return;if(requests.size>=16)throw inputError();const view=requestView(request);requests.set(view.id,view);phase='waiting';update();}).catch(()=>void dispose('error'));
    });
    activeWorker.client.on('disconnected',()=>{if(active()){problem='Hermes stopped. Its actions were not automatically repeated.';void dispose('error');}});
  }
  const api={
    async status(){await ensureOwner();return snapshot();},
    async prepare(){
      const admission=cancellation,profile=await ensureOwner();if(admission!==cancellation)throw unavailable();
      if(worker||starting||preparing||lingeringWorker||lingeringPreparation||stopping)throw Object.assign(new Error('Stop the current Hermes workspace before preparing its tools.'),{status:409,code:'HERMES_WORKSPACE_BUSY'});
      if(!isAbsolute(pythonPath||'')||!isAbsolute(sourceRoot||''))throw Object.assign(new Error('Prepare the included Hermes assistant in Settings first.'),{status:409,code:'HERMES_WORKSPACE_RUNTIME'});
      phase='preparing';problem='';available=readiness();preparation={phase:'preparing',progress:null,tools:null};update();
      const ticket=++generation;const setupController=new AbortController();controller=setupController;
      const task=Promise.resolve().then(async()=>{
        const stillPreparing=()=>ticket===generation&&!closed&&!setupController.signal.aborted;
        try{
          await owner();await assertIdle();
          const home=await prepareWorkspace({profileId,profileDataDir:join(dataDir,'profiles',profileId)});await owner();await assertIdle();
          if(!stillPreparing())return;
          guardTimer=setInterval(()=>void owner().catch(()=>dispose()),1000);guardTimer.unref?.();
          const result=await prepareTools({profile,dataDir,pythonPath,sourceRoot,home,signal:setupController.signal,onProgress:progress=>{
            if(!stillPreparing()||!progress||!['agent-browser','chromium','cua-driver'].includes(progress.package)||!['prepare','download','unpack','verify','ready'].includes(progress.stage))return;
            preparation.progress={package:progress.package,stage:progress.stage,...(Number.isFinite(progress.done)&&progress.done>=0?{done:progress.done}:{}),...(Number.isFinite(progress.total)&&progress.total>=0?{total:progress.total}:{})};update();
          }});
          if(!stillPreparing())return;await owner();
          const tools=Object.fromEntries(['browser','computer'].map(name=>[name,{available:result?.tools?.[name]?.available===true,message:text(result?.tools?.[name]?.message,1000)}]));
          preparation={phase:result?.ok===true&&tools.browser.available&&tools.computer.available?'complete':'incomplete',progress:null,tools};phase='stopped';update();
        }catch(error){
          if(error?.code==='HERMES_WORKSPACE_STOP_UNCONFIRMED'||error?.stopUnconfirmed===true){lingeringPreparation=task;phase='error';problem='The tool setup could not be confirmed stopped. Quit Nemo before continuing.';preparation={phase:'error',progress:null,tools:null};update();throw stopUnconfirmed();}
          if(stillPreparing()){phase='error';problem='Hermes could not finish preparing browser and computer tools. Check the connection and try again.';preparation={phase:'error',progress:null,tools:null};update();}
        }finally{clearInterval(guardTimer);guardTimer=null;if(preparing===task)preparing=null;if(ticket===generation)controller=null;update();}
      });
      preparing=task;void task.catch(()=>{});return snapshot();
    },
    async start(){
      const admission=cancellation;await ensureOwner();if(admission!==cancellation)throw unavailable();
      if(starting)return starting;
      if(lingeringWorker||preparing||lingeringPreparation||stopping)throw Object.assign(new Error('Finish preparing or stop the earlier Hermes work before opening another workspace.'),{status:409,code:'HERMES_WORKSPACE_BUSY'});
      if(worker)return snapshot();
      if(!isAbsolute(pythonPath||'')||!isAbsolute(sourceRoot||''))throw Object.assign(new Error('Prepare the included Hermes assistant in Settings first.'),{status:409,code:'HERMES_WORKSPACE_RUNTIME'});
      starting=(async()=>{
        phase='starting';problem='';requests.clear();update();const ticket=++generation,startupController=new AbortController();controller=startupController;
        const stillStarting=()=>{if(ticket!==generation||closed||startupController.signal.aborted)throw unavailable();};
        try {
          // Reserve this mode before these asynchronous checks. Main chat's
          // admission gate observes isBusy(), while this callback catches a
          // normal reply admitted just before the reservation existed.
          const profile=await owner();stillStarting();await assertIdle();stillStarting();
          const home=await prepareWorkspace({profileId,profileDataDir:join(dataDir,'profiles',profileId)});
          stillStarting();await owner();stillStarting();await assertIdle();stillStarting();
          const session=await chatgptSession();stillStarting();await owner();stillStarting();await assertIdle();stillStarting();
          const nextBroker=await createBroker({session,nativeTools:true,signal:startupController.signal,authorize:async()=>{try{await owner();return true;}catch{return false;}},onFailure:()=>{problem='Reconnect ChatGPT in Settings, or check your plan usage.';update();}});
          if(ticket!==generation||startupController.signal.aborted){await nextBroker.close();throw unavailable();}broker=nextBroker;
          await owner();stillStarting();await assertIdle();stillStarting();
          const nextWorker=await startWorker({profile,dataDir,pythonPath,sourceRoot,home,brokerUrl:broker.baseUrl,brokerGrant:broker.capability,model:broker.model,signal:startupController.signal});
          if(ticket!==generation||startupController.signal.aborted){
            try{await nextWorker.close();}catch{lingeringWorker=nextWorker;phase='error';problem='Some running Hermes work could not be confirmed stopped. Try Stop Hermes again before continuing.';update();}
            throw unavailable();
          }worker=nextWorker;attach(worker,ticket);
          const prior=await savedSession(home,profileId);
          const created=await worker.client.request(prior?'session.resume':'session.create',{profile:'default',source:'tui',close_on_disconnect:true,...(prior?{session_id:prior}:{})});
          if(!created||!sessionId(created.session_id))throw unavailable();
          currentSession=created.session_id;available=readiness(created.info||worker.readiness);messages=restoredMessages(created.messages);await owner();
          await writeJson(join(home,'nemo-workspace-session.json'),{version:1,profileId,sessionId:sessionId(created.stored_session_id)?created.stored_session_id:created.session_id});
          if(ticket!==generation)throw unavailable();
          phase='ready';update();
          guardTimer=setInterval(()=>void owner().catch(()=>dispose()),1000);guardTimer.unref?.();
          return snapshot();
        }catch(error){
          if(error?.stopUnconfirmed===true||error?.code==='HERMES_WORKSPACE_STOP_UNCONFIRMED'){
            lingeringWorker=worker||lingeringWorker||{close:typeof error.close==='function'?()=>error.close():async()=>{throw stopUnconfirmed();}};
            phase='error';problem='Some running Hermes work could not be confirmed stopped. Try Stop Hermes again before continuing.';update();
          }
          if(ticket===generation){problem=lingeringWorker?problem:error?.code==='CHATGPT_SIGN_IN_REQUIRED'?'Connect ChatGPT in Settings before opening Hermes workspace.':'Hermes workspace could not start. Your existing Nemo chats are kept.';await dispose('error',{waitForStart:false});}
          throw error?.status?error:unavailable();
        }
        finally{starting=null;}
      })();return starting;
    },
    async prompt(input){
      await ensureOwner();
      if(!keysOnly(input,['message'])||typeof input.message!=='string'||!input.message.trim()||input.message.length>32000)throw inputError();
      if(!worker||!currentSession||phase!=='ready')throw Object.assign(new Error('Open Hermes workspace and finish its current reply first.'),{status:409,code:'HERMES_WORKSPACE_BUSY'});
      phase='running';problem='';messages.push({id:randomUUID(),role:'user',content:input.message.trim()});messages=messages.slice(-60);update();
      try{await worker.client.request('prompt.submit',{profile:'default',session_id:currentSession,text:input.message.trim()});await ensureOwner();return snapshot();}
      catch(error){problem='The reply could not be confirmed. It was not submitted again.';await dispose('error');throw error?.status?error:unavailable();}
    },
    async respond(input){
      await ensureOwner();
      if(!keysOnly(input,['id','result'])||typeof input.id!=='string')throw inputError();
      const request=requests.get(input.id);if(!worker||!request)throw Object.assign(new Error('This Hermes request has expired or was already answered.'),{status:409,code:'HERMES_WORKSPACE_REQUEST'});
      const result=responseFor(request,input.result);await ensureOwner();
      if(!worker||requests.get(input.id)!==request)throw Object.assign(new Error('This Hermes request has expired or was already answered.'),{status:409,code:'HERMES_WORKSPACE_REQUEST'});
      worker.client.answer(input.id,result);requests.delete(input.id);phase=requests.size?'waiting':'running';update();return snapshot();
    },
    async stop(){await ensureOwner();await dispose();return snapshot();},
    isBusy(){return !!worker||!!lingeringWorker||!!starting||!!preparing||!!lingeringPreparation||!!stopping;},
    async invalidate(){await dispose();if(lingeringWorker||lingeringPreparation)throw stopUnconfirmed();},
    async close(){if(closed&&!lingeringWorker&&!lingeringPreparation&&!stopping&&!starting&&!preparing)return;closed=true;await dispose();if(lingeringWorker||lingeringPreparation)throw stopUnconfirmed();},
  };
  // Metadata-only readiness. Starting is always an explicit owner action.
  await owner();await Promise.resolve().then(()=>chatgptStatus()).catch(()=>({connected:false}));
  return api;
}

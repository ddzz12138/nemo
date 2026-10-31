import { EventEmitter } from 'node:events';
import { randomUUID,createHash } from 'node:crypto';

export function nativeFake({ beforeReply=async()=>{},toolForPrompt,questionForPrompt }={}) {
  const calls=[],workers=[],sessions=new Map(),owners=new Map(),answers=[];let prompts=0;
  const forward=async input=>{
    if(input.path==='/v1/models')return Response.json({data:[{id:'synthetic-model'}]});
    calls.push(input);await beforeReply(input);
    return Response.json({text:`Synthetic private reply for ${input.profileId}: ${input.body.messages.at(-1).content}`});
  };
  const startWorker=async options=>{
    const client=new EventEmitter();client.closed=false;client.guardVerified=true;const owned=new Map(),questions=new Map();
    client.answer=(id,result)=>{const pending=questions.get(id);if(!pending)throw new Error('Question expired');questions.delete(id);answers.push({profileId:options.profile.id,result});pending.resolve(result);};
    client.registerStoredSession=({profileId,sessionId})=>{if(profileId!==options.profile.id||owners.get(sessionId)!==profileId)throw new Error('Foreign stored session.');};
    client.request=async(method,params)=>{
      if(method==='client.capabilities')return{};
      if(method==='session.list')return{sessions:[...sessions.entries()].filter(([,value])=>value.profileId===options.profile.id&&(!params.title||params.title===value.title)).map(([id,value])=>({id,title:value.title}))};
      if(method==='session.create'){const session={session_id:'live_'+randomUUID(),stored_session_id:'stored_'+randomUUID()};owners.set(session.stored_session_id,options.profile.id);sessions.set(session.stored_session_id,{profileId:options.profile.id,title:params.title||'',messages:structuredClone(params.messages||[])});owned.set(session.session_id,session.stored_session_id);return session;}
      if(method==='session.resume'){const stored=sessions.get(params.session_id);if(stored?.profileId!==options.profile.id)throw new Error('Foreign history.');const session={session_id:[...owned.entries()].find(([,id])=>id===params.session_id)?.[0]||'live_'+randomUUID(),stored_session_id:params.session_id};owned.set(session.session_id,session.stored_session_id);return session;}
      if(method==='session.close')return{closed:owned.delete(params.session_id)};
      if(method==='nemo.history.targets'){const stored=sessions.get(params.session_id);return{resume_id:stored?params.session_id:null,targets:stored?[{id:params.session_id,fingerprint:createHash('sha256').update(JSON.stringify(stored.messages)).digest('hex')}]:[]};}
      if(method==='nemo.history.delete'){if([...owned.values()].includes(params.session_id))throw new Error('Session still active');for(const row of params.targets){const stored=sessions.get(row.id);if(stored&&row.fingerprint!==createHash('sha256').update(JSON.stringify(stored.messages)).digest('hex'))throw new Error('Transcript changed');sessions.delete(row.id);}return{deleted:true,files_removed:true,records:params.targets.length};}
      if(method==='session.delete'){if(!sessions.has(params.session_id))throw Object.assign(new Error('Missing session'),{rpcCode:4007});if([...owned.values()].includes(params.session_id))throw new Error('Session still active');sessions.delete(params.session_id);return{deleted:params.session_id};}
      if(method==='session.history'){const stored=sessions.get(owned.get(params.session_id));if(stored?.profileId!==options.profile.id)throw new Error('Foreign history');return{messages:structuredClone(stored.messages),count:stored.messages.length};}
      if(method==='session.undo'){const stored=sessions.get(owned.get(params.session_id));if(stored?.profileId!==options.profile.id)throw new Error('Foreign history');const index=stored.messages.findLastIndex(row=>row.role==='user');if(index<0)return{removed:0};const removed=stored.messages.length-index;stored.messages.splice(index);return{removed};}
      if(method==='session.branch'){const parent=sessions.get(owned.get(params.session_id));if(parent?.profileId!==options.profile.id)throw new Error('Foreign history');const session={session_id:'live_'+randomUUID(),stored_session_id:'stored_'+randomUUID()};owners.set(session.stored_session_id,options.profile.id);sessions.set(session.stored_session_id,{profileId:options.profile.id,title:params.name,messages:structuredClone(parent.messages)});owned.set(session.session_id,session.stored_session_id);return session;}
      if(method==='session.usage')return{input:12,output:3,total:15,api_key:'NEVER_RETURN'};
      if(method==='prompt.submit'){
        prompts++;const stored=sessions.get(owned.get(params.session_id));if(stored?.profileId!==options.profile.id)throw new Error('Foreign live session.');stored.messages.push({role:'user',content:params.text});
        client.emit('status',{phase:'thinking',verb:'reflecting'});
        void fetch(options.brokerUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${options.brokerGrant}`,'Content-Type':'application/json'},body:JSON.stringify({model:'synthetic-model',messages:stored.messages})}).then(async response=>{
          if(!response.ok)throw new Error('Broker rejected synthetic inference.');
          const result=await response.json(),tool=toolForPrompt?.(params.text,options);
          for(const selected of tool?Array.isArray(tool)?tool:[tool]:[]){
            const read=await fetch(options.brokerUrl+'/nemo/tools/call',{method:'POST',headers:{Authorization:`Bearer ${options.brokerGrant}`,'Content-Type':'application/json'},body:JSON.stringify({callId:randomUUID(),...selected})});
            if(!read.ok)throw new Error('Broker rejected the synthetic tool.');result.text+=' '+JSON.stringify(await read.json());
          }
          const question=questionForPrompt?.(params.text,options);
          if(question){
            async function admit(name){const callId=randomUUID(),response=await fetch(options.brokerUrl+'/nemo/tools/call',{method:'POST',headers:{Authorization:`Bearer ${options.brokerGrant}`,'Content-Type':'application/json'},body:JSON.stringify({callId,name,arguments:{}})});if(!response.ok)throw new Error('Interaction denied');return{callId,name};}
            const planCall=await admit('todo_list');client.emit('activity',{sessionId:params.session_id,type:'todo.updated',payload:{revision:1,todos:[{id:'one',content:'Choose a synthetic preference',status:'in_progress'}]}});client.emit('interaction',{...planCall,state:'completed'});
            const clarifyCall=await admit('clarify'),id=randomUUID();const reply=await new Promise((resolve,reject)=>{questions.set(id,{resolve,reject});client.emit('question',{id,method:'clarify',params:{session_id:params.session_id,questions:question}});});result.text+=' '+JSON.stringify(reply.answers);client.emit('interaction',{...clarifyCall,state:'completed'});
            const doneCall=await admit('todo_list');client.emit('activity',{sessionId:params.session_id,type:'todo.updated',payload:{revision:2,todos:[{id:'one',content:'Choose a synthetic preference',status:'completed'}]}});client.emit('interaction',{...doneCall,state:'completed'});
          }
          if(client.closed)return;stored.messages.push({role:'assistant',content:result.text});client.emit('activity',{sessionId:params.session_id,type:'message.delta',payload:{text:result.text}});client.emit('activity',{sessionId:params.session_id,type:'message.complete',payload:{status:'complete',text:result.text,reasoning:'PRIVATE_INTERNAL_VALUE'}});
        }).catch(()=>{if(!client.closed)client.emit('activity',{sessionId:params.session_id,type:'error',payload:{}});});
        return{status:'streaming'};
      }
      throw new Error('Unsupported fake RPC');
    };
    const worker={profileId:options.profile.id,client,close(){if(client.closed)return;client.closed=true;for(const item of questions.values())item.reject(new Error('Worker stopped'));questions.clear();client.emit('disconnected');}};workers.push(worker);return worker;
  };
  return{forward,startWorker,calls,workers,answers,get prompts(){return prompts;},verifyRuntime:async()=>({supported:true,policy:'chat-only',managedReads:true,managedInteractions:true})};
}

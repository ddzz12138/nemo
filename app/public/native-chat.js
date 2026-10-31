(() => {
  'use strict';
  const list=document.getElementById('previewMessages'),status=document.getElementById('previewStatus'),form=document.getElementById('previewForm'),input=document.getElementById('previewInput'),send=document.getElementById('previewSend'),reconnect=document.getElementById('previewReconnect'),connections=document.getElementById('previewConnections'),newChat=document.getElementById('previewNew');
  const supplied=new URL(location.href).searchParams.get('conversation');
  let conversationId=/^[a-f0-9-]{36}$/.test(supplied||'')?supplied:null,conversation=null,timer=null,stopped=false,posting=false,draft=null,changing=false,renderedSignature=null,refreshTicket=0,live=null,refreshing=false,refreshAgain=false;
  const controller=new AbortController(),headers={'Content-Type':'application/json','X-Nemo-Request':'1'};
  function clearPrivate(){refreshTicket++;list.replaceChildren();window.NemoNativeInteractions?.clear();renderedSignature=null;input.value='';draft=null;conversation=null;conversationId=null;form.hidden=true;connections.checked=false;connections.disabled=true;clearTimeout(timer);}
  async function api(path,options={}){const response=await window.nemoFetch(path,{...options,signal:controller.signal});const data=await response.json();if(!response.ok){if(response.status===401)clearPrivate();throw Object.assign(new Error(data.error||'Nemo could not complete that request.'),{status:response.status});}return data;}
  const node=(tag,text,className)=>{const value=document.createElement(tag);value.textContent=text;if(className)value.className=className;return value;};
  function taskContent(task,card){
    const progress=node('small',task.phase==='complete'?'Complete':task.phase==='queued'?'Queued':task.phase==='running'?`Hermes is ${task.verb||'working'}…`:task.phase==='waiting'?task.reason==='capacity'?'Waiting for the server to continue':'Waiting for your answer':task.phase==='cancelled'?'Stopped. This message will not be sent again automatically.':task.reason==='question-expired'?'The question expired. Start a new message to continue.':task.reason==='budget'?'Paused at the task limit. You can allow more time and tool reads.':'Paused. Check the saved conversation before retrying.');card.append(progress);window.NemoActivity?.render(card,task.activity);window.NemoNativeInteractions?.render(card,task,{onAnswer:async(id,value)=>{await api(`/api/native/tasks/${id}/answer`,{method:'POST',headers,body:JSON.stringify(value)});await refresh();}});
    if(['queued','running','waiting'].includes(task.phase)){const stop=node('button','Stop');stop.type='button';stop.addEventListener('click',async()=>{stop.disabled=true;try{await api(`/api/native/tasks/${task.id}/stop`,{method:'POST',headers,body:'{}'});await refresh();}catch(error){status.textContent=error.message;}});card.append(stop);}
    if(task.phase==='paused'&&task.reason==='budget'){const more=node('button','Allow 10 more minutes');more.type='button';more.addEventListener('click',async()=>{if(!window.confirm('Allow this task ten more active minutes and up to 64 additional tool calls?'))return;more.disabled=true;try{await api(`/api/native/tasks/${task.id}/extend`,{method:'POST',headers,body:'{}'});await refresh();}catch(error){status.textContent=error.message;}});card.append(more);}
  }
  function render(tasks){
    const signature=JSON.stringify({conversation,tasks});if(signature===renderedSignature)return;renderedSignature=signature;
    const fragment=document.createDocumentFragment(),ordered=[...tasks].reverse(),used=new Set();let card=null;
    for(const row of conversation?.messages||[]){
      if(row.role==='user'||!card){card=node('section','','preview-message');fragment.append(card);}card.append(node('p',row.text,row.role==='user'?'preview-question':''));
      if(row.role==='assistant'){const task=ordered.find(task=>!used.has(task.id)&&task.phase==='complete'&&task.text===row.text);if(task){used.add(task.id);taskContent(task,card);}}
    }
    for(const task of ordered){if(used.has(task.id))continue;const card=node('section','','preview-message');card.append(node('p',task.message,'preview-question'),node('p',task.text||''));taskContent(task,card);fragment.append(card);}
    list.replaceChildren(fragment);document.getElementById('previewTitle').textContent=conversation?.title||'A new conversation';
  }
  function select(id){conversationId=id;const url=new URL(location.href);if(id)url.searchParams.set('conversation',id);else url.searchParams.delete('conversation');history.replaceState(null,'',url);}
  async function refresh(){
    if(stopped||changing||document.hidden)return;if(refreshing){refreshAgain=true;return;}refreshing=true;const ticket=++refreshTicket;clearTimeout(timer);
    try{const data=await api('/api/native/tasks');if(stopped||changing||ticket!==refreshTicket)return;
      if(!conversationId&&data.tasks[0]?.conversationId)select(data.tasks[0].conversationId);
      const tasks=conversationId?data.tasks.filter(task=>task.conversationId===conversationId):data.tasks;
      const active=tasks.some(task=>['queued','running','waiting'].includes(task.phase));
      if(conversationId&&!active)try{const selected=conversationId,value=await api('/api/native/conversations/'+selected);if(ticket===refreshTicket&&selected===conversationId&&!stopped&&!changing)conversation=value;}catch(error){if(error.status!==409)throw error;}
      if(stopped||changing||ticket!==refreshTicket)return;render(tasks);form.hidden=conversation?.canContinue===false||tasks.some(task=>task.phase==='waiting');newChat.disabled=data.tasks.some(task=>['queued','running','waiting'].includes(task.phase));send.textContent=active?'Queue ↗':'Send ↗';reconnect.hidden=true;status.textContent=conversation?.readOnlyReason||'Your chats are private and available on your paired devices.';
      timer=setTimeout(refresh,live?.connected?10000:active?700:4000);
    }catch(error){if(stopped||changing||ticket!==refreshTicket)return;form.hidden=true;reconnect.hidden=false;status.textContent=error.message+' Reconnect to check saved History. Your message will not be sent again automatically.';}
    finally{refreshing=false;if(refreshAgain&&!stopped&&!changing){refreshAgain=false;clearTimeout(timer);timer=setTimeout(refresh,0);}}
  }
  async function startNew(){changing=true;refreshTicket++;clearTimeout(timer);try{const result=await api('/api/native/conversations',{method:'POST',headers,body:'{}'});select(result.conversation.id);conversation=result.conversation;draft=null;renderedSignature=null;window.NemoNativeInteractions?.clear();input.value='';list.replaceChildren();}finally{changing=false;if(!stopped)timer=setTimeout(refresh,700);}await refresh();input.focus();}
  reconnect.addEventListener('click',()=>{reconnect.hidden=true;void refresh();});newChat.addEventListener('click',async()=>{newChat.disabled=true;try{await startNew();}catch(error){status.textContent=error.message;}finally{newChat.disabled=false;}});
  connections.addEventListener('change',async()=>{connections.disabled=true;changing=true;refreshTicket++;clearTimeout(timer);try{await api('/api/integrations/consent',{method:'POST',headers,body:JSON.stringify({enabled:connections.checked})});changing=false;await startNew();}catch(error){connections.checked=!connections.checked;status.textContent=error.message;}finally{changing=false;connections.disabled=false;if(!stopped)timer=setTimeout(refresh,700);}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(posting||stopped)return;const message=input.value.trim();if(!message)return;
    if(!draft||draft.message!==message||(draft.conversationId||null)!==conversationId)draft={requestKey:crypto.randomUUID(),message,...(conversationId?{conversationId}:{})};posting=true;send.disabled=true;
    try{const result=await api('/api/native/tasks',{method:'POST',headers,body:JSON.stringify(draft)});if(result.task.conversationId)select(result.task.conversationId);input.value='';draft=null;await refresh();}
    catch(error){status.textContent=error.message+' If submission was interrupted, check the conversation before retrying.';}
    finally{posting=false;send.disabled=false;}
  });
  window.addEventListener('pagehide',()=>{stopped=true;live?.close();clearPrivate();controller.abort();});window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  void(async()=>{try{const connection=await api('/api/native/status');if(!connection.available){status.textContent='The host has not enabled this preview. Your main chat is still available.';return;}const permission=await api('/api/integrations');connections.checked=permission.contextConsent===true;connections.disabled=!connection.connectionsSupported||!permission.permissions?.length;form.hidden=false;await refresh();live=window.NemoNativeStream?.start({onChange:()=>void refresh(),onState:value=>{if(value==='unauthorized'){stopped=true;clearPrivate();controller.abort();status.textContent='Your sign-in changed. Reload Nemo before continuing.';}else if(value==='reconnecting')void refresh();}});}catch(error){clearPrivate();status.textContent=error.message;}})();
})();

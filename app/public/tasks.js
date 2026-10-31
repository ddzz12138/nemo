(() => {
  'use strict';
  const list=document.getElementById('tasksList'),status=document.getElementById('tasksStatus'),controller=new AbortController(),cards=new Map(),groups=new Map();
  const headers={'Content-Type':'application/json','X-Nemo-Request':'1'};let disposed=false,loading=false,timer,live=null,mainActive=false,lastRefresh=0;
  const node=(tag,text,className)=>{const value=document.createElement(tag);value.textContent=text;if(className)value.className=className;return value;};
  for(const[id,title]of [['attention','Needs you'],['working','Working'],['recent','Recent']]){const section=node('section','','task-group');section.setAttribute('aria-label',title);section.append(node('h2',title));const content=node('div','');section.append(content);section.hidden=true;groups.set(id,{section,content});list.append(section);}
  async function api(path,options={}){const response=await window.nemoFetch(path,{...options,signal:controller.signal}),value=await response.json();if(!response.ok){if(response.status===401){cards.clear();for(const group of groups.values())group.content.replaceChildren();window.NemoNativeInteractions?.clear();}throw new Error(value.error||'Tasks could not be loaded.');}return value;}
  function groupFor(task){return task.phase==='waiting'&&task.reason==='question'||task.phase==='paused'?'attention':task.canStop?'working':'recent';}
  function label(task){if(task.phase==='waiting')return task.reason==='capacity'?'Waiting for the server to continue':'Waiting for your answer';if(task.phase==='paused')return task.reason==='budget'?'Paused at the task limit':task.reason==='question-expired'?'Question expired. Open the conversation before continuing.':'Paused. Check the saved conversation before retrying.';return{queued:'Queued',running:'Working',completed:'Complete',cancelled:'Stopped',failed:'Could not finish'}[task.status]||'Check this conversation';}
  function renderCard(task){
    const card=node('article','','profile-card task-card');card.dataset.taskId=task.id;card.dataset.source=task.source||'main';card.append(node('h3',task.title),node('p',`${label(task)} · ${new Date(task.createdAt).toLocaleString()}`,'task-detail'));
    window.NemoActivity?.render(card,task.activity);
    if(task.source==='native')window.NemoNativeInteractions?.render(card,task,{onAnswer:async(id,value)=>{await api(`/api/native/tasks/${id}/answer`,{method:'POST',headers,body:JSON.stringify(value)});await refresh();}});
    const actions=node('div','','profile-actions'),open=node('a',task.source==='native'?'Open conversation ↗':'Open chat ↗');open.href=task.source==='native'?'/native-chat.html'+(task.conversationId?'?'+new URLSearchParams({conversation:task.conversationId}):''):'/';actions.append(open);
    function action(text,suffix,confirm){const button=node('button',text);button.type='button';button.addEventListener('click',async()=>{if(confirm&&!window.confirm(confirm))return;button.disabled=true;try{await api((task.source==='native'?'/api/native/tasks/':'/api/tasks/')+task.id+'/'+suffix,{method:'POST',headers,body:'{}'});await refresh();}catch(error){if(!disposed)status.textContent=error.message;button.disabled=false;}});actions.append(button);}
    if(task.canStop)action('Stop task','stop');
    if(task.source==='native'&&task.canExtend)action('Allow more time','extend','Allow this task ten more active minutes and up to 64 additional tool calls?');
    card.append(actions);return card;
  }
  function render(tasks){
    const seen=new Set(),positions={attention:0,working:0,recent:0};
    for(const task of tasks){const key=(task.source||'main')+':'+task.id,signature=JSON.stringify(task),group=groups.get(groupFor(task));let saved=cards.get(key);seen.add(key);
      if(!saved||saved.signature!==signature){const card=renderCard(task);saved?.card.replaceWith(card);saved={card,signature};cards.set(key,saved);}
      const index=positions[groupFor(task)]++;if(group.content.children[index]!==saved.card)group.content.insertBefore(saved.card,group.content.children[index]||null);
    }
    for(const[key,saved]of cards)if(!seen.has(key)){saved.card.remove();cards.delete(key);}
    for(const[id,group]of groups)group.section.hidden=positions[id]===0;
  }
  async function refresh(){
    if(disposed||loading||document.hidden)return;loading=true;
    try{const result=await api('/api/tasks');if(disposed)return;render(result.tasks);mainActive=result.tasks.some(task=>task.source!=='native'&&task.canStop);lastRefresh=Date.now();status.textContent=result.notice||(result.tasks.length?'':'Your first task starts with a message in chat.');}
    catch(error){if(!disposed)status.textContent=error.message;}finally{loading=false;}
  }
  const close=()=>{disposed=true;live?.close();controller.abort();clearInterval(timer);cards.clear();list.replaceChildren();window.NemoNativeInteractions?.clear();};
  window.addEventListener('pagehide',close,{once:true});window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});timer=setInterval(()=>{if(!live?.connected||mainActive||Date.now()-lastRefresh>=10000)void refresh();},2000);void refresh();live=window.NemoNativeStream?.start({onChange:()=>void refresh(),onState:value=>{if(value==='unauthorized'){close();status.textContent='Your sign-in changed. Reload Nemo before continuing.';}else if(value==='reconnecting')void refresh();}});
})();

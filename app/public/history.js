(() => {
  'use strict';
  const status = document.getElementById('status'); const list = document.getElementById('historyList'); const view = document.getElementById('conversationView'); const messages = document.getElementById('conversationMessages');
  const query=document.getElementById('historyQuery'),importButton=document.getElementById('importHistory'),controller=new AbortController();let epoch=0,stopped=false;
  const node = (tag, text, className) => { const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; return value; };
  async function api(path, input) { const response = await window.nemoFetch(path, { method: input ? 'POST' : 'GET',signal:controller.signal, headers: input ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}, ...(input ? { body: JSON.stringify(input) } : {}) }); const value = await response.json(); if (!response.ok) {if(response.status===401){epoch++;list.replaceChildren();messages.replaceChildren();view.hidden=true;}throw new Error(value.error || 'History could not be loaded.');} return value; }
  function failure(error) { if(stopped)return;status.textContent = error.message; status.dataset.error = 'true'; }
  const endpoint=item=>item.source==='native'?`/api/native/conversations/${item.id}`:`/api/history/${item.id}`;
  function button(label,action){const value=node('button',label);value.type='button';value.addEventListener('click',async()=>{value.disabled=true;try{await action();}catch(error){failure(error);}finally{value.disabled=false;}});return value;}
  async function remove(item){
    if(item.source==='native'){const preview=await api(endpoint(item)+'/delete-preview',{});if(!window.confirm(`Delete “${preview.title}” (${preview.count} messages)?\n\n${preview.disclosure}`))return;await api(endpoint(item)+'/delete',{token:preview.token,revision:preview.revision});}
    else{if(!window.confirm('Clear this conversation from your Nemo profile? Saved Memory and any legacy Hermes records/backups are separate.'))return;await api(endpoint(item)+'/clear',{});}
    view.hidden=true;document.getElementById('historySearch').hidden=false;messages.replaceChildren();list.hidden=false;await refresh();status.textContent='Conversation deleted. Saved Memory and private backups were left unchanged.';
  }
  async function refresh() {
    const version=++epoch;status.textContent = ''; status.dataset.error = 'false'; const result = await api('/api/history'+(query.value.trim()?'?query='+encodeURIComponent(query.value.trim()):''));if(stopped||version!==epoch)return; list.replaceChildren();importButton.hidden=!result.nativeHistory;
    for (const item of result.conversations) {
      const card = node('section', '', 'profile-card'); card.append(node('h2', item.title), node('p', `${item.count} messages · ${item.source==='native'?item.imported?'earlier chat in private History':'Hermes chat':item.active?'main conversation':'earlier conversation'}${item.status==='deleting'?' · deletion incomplete':''}`));
      const actions = node('div', '', 'profile-actions'); const open = node('button', 'View conversation'); open.type = 'button'; open.addEventListener('click', () => void show(item).catch(failure));
      const clear = button(item.status==='deleting'?'Review deletion':'Delete conversation',()=>remove(item));
      actions.append(open, clear); card.append(actions); list.append(card);
    }
    if(!result.conversations.length)list.append(node('p',query.value.trim()?'No conversations match those words.':'Your conversations will appear here.','intro'));
  }
  async function show(item) {
    const version=++epoch,conversation=await api(endpoint(item));if(stopped||version!==epoch)return;messages.replaceChildren();document.getElementById('conversationTitle').textContent=conversation.title||item.title;const actions=document.getElementById('conversationActions');actions.replaceChildren();document.getElementById('conversationNotice').textContent=conversation.needsReconciliation?'This conversation has an interrupted change. Refresh it to check the stored result.':conversation.readOnlyReason||(conversation.stale?'Showing the last saved display copy. Hermes is temporarily unavailable; refresh before making changes.':'');
    if(item.source==='native'){
      if(conversation.canContinue){const link=node('a','Continue in chat');link.href='/native-chat.html?conversation='+encodeURIComponent(item.id);actions.append(link);
        actions.append(button('Branch',async()=>{const result=await api(endpoint(item)+'/branch',{revision:conversation.revision,requestKey:crypto.randomUUID()});await show({id:result.conversation.id,source:'native',title:result.conversation.title});status.textContent='A separate conversation now starts from this point.';}));
        actions.append(button('Undo last turn',async()=>{const preview=await api(endpoint(item)+'/undo-preview',{});if(!window.confirm(`Remove your last turn and its reply?\n\n${preview.message.slice(0,240)}\n\nSaved Memory is separate.`))return;await api(endpoint(item)+'/undo',{token:preview.token,revision:preview.revision});await show(item);}));
      }
      actions.append(button('Rename',async()=>{const title=window.prompt('Conversation title',conversation.title);if(title===null)return;await api(endpoint(item)+'/rename',{title,revision:conversation.revision});await show(item);}));
    }
    actions.append(button('Delete conversation',()=>remove(item)));
    for(const message of conversation.messages){const row=node('div','','history-message');row.append(node('strong',message.role==='user'?'You':'Nemo'),node('p',message.text,'history-content'));window.NemoActivity?.render(row,message.activity);messages.append(row);}list.hidden=true;document.getElementById('historySearch').hidden=true;view.hidden=false;status.textContent='';
  }
  document.getElementById('backToList').addEventListener('click', () => { epoch++;view.hidden = true;document.getElementById('historySearch').hidden=false; messages.replaceChildren(); list.hidden = false;void refresh().catch(failure); });
  document.getElementById('historySearch').addEventListener('submit',event=>{event.preventDefault();view.hidden=true;messages.replaceChildren();list.hidden=false;void refresh().catch(failure);});document.getElementById('historyReset').addEventListener('click',()=>{query.value='';view.hidden=true;messages.replaceChildren();list.hidden=false;void refresh().catch(failure);});
  importButton.addEventListener('click',async()=>{importButton.disabled=true;let total=0;try{let result;do{result=await api('/api/native/history/import',{});total+=result.imported;status.textContent=`Imported ${total} earlier conversations…`;}while(result.remaining&&!stopped);await refresh();status.textContent=total?`Imported ${total} conversations. Your private migration backups were retained.`:'Earlier chats are already imported.';}catch(error){failure(error);}finally{importButton.disabled=false;}});
  window.addEventListener('pagehide',()=>{stopped=true;epoch++;query.value='';messages.replaceChildren();list.replaceChildren();controller.abort();});window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
  void refresh().catch(failure);
})();

import {getProfileMemoryFetch} from './memory-auth.js';
const TOPICS={all:'All memories',personal:'About you',preferences:'Preferences',projects:'Projects',people:'People',forgotten:'Not used'};
const clear=node=>{node.textContent='';};
const shortTitle=value=>String(value).replace(/\s+/g,' ').trim().slice(0,90);
export function createMemoryApp(doc,fetchImpl=globalThis.fetch){
  const root=doc.getElementById('memory-root')||doc.body;
  const state={board:null,topic:'all',query:'',shown:12,selection:[],editor:null,confirmation:null,saving:false,deleting:false,sequence:0};
  let idle=Promise.resolve(),refreshTimer=null,opener=null;
  const track=promise=>{idle=Promise.resolve(promise).catch(error=>{message(error.message);if(!state.board){summaryBody.textContent='Memory is not ready yet.';summaryMeta.textContent='Check Memory setup on your computer, then reload this page.';resultsLabel.textContent='Your conversations are still available in History.';}});return idle;};
  const el=(tag,attrs={},...children)=>{const node=doc.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(key==='text')node.textContent=value;else if(key==='class')node.setAttribute('class',value);else if(['type','value','hidden','disabled','checked','maxLength','required'].includes(key))node[key]=value;else node.setAttribute(key,value);}node.append(...children);return node;};
  const button=(text,action,attrs={})=>{const node=el('button',{type:'button',text,...attrs});node.addEventListener('click',action);return node;};
  const link=(text,href)=>el('a',{href,text});
  const main=el('main',{class:'memory-main'});
  const who=el('span',{class:'memory-person',text:fetchImpl.profile?.name||'Your profile'});
  const settingsButton=button('···',()=>openDialog(settingsDialog,settingsLearning),{'aria-label':'Memory settings',class:'memory-round'});
  const header=el('header',{class:'memory-header'},link('‹ Nemo','/'),who,settingsButton);
  const notice=el('p',{id:'memory-message',role:'status','aria-live':'polite',hidden:true});
  const summaryBody=el('div',{id:'memory-summary',class:'memory-summary',tabindex:'0','aria-label':'Memory summary. Select text to correct it.'});
  const summaryMeta=el('p',{id:'memory-summary-meta',class:'memory-meta',text:'Loading your memories…'});
  const summaryEdit=button('Correct summary',()=>chooseSummary(state.board?.summary.segments||[]),{class:'memory-text-button',disabled:true});
  const selectionButton=button('Correct selected text',()=>chooseSummary(state.selection),{id:'memory-correct-selection',class:'memory-primary',hidden:true});
  selectionButton.addEventListener('mousedown',event=>event.preventDefault());
  const summarySection=el('section',{class:'memory-overview','aria-labelledby':'memory-summary-title'},el('div',{class:'memory-section-heading'},el('h2',{id:'memory-summary-title',text:'What Nemo remembers'}),summaryEdit),summaryBody,summaryMeta,el('p',{class:'memory-hint',text:'Highlight a sentence to correct the memory behind it.'}),selectionButton);
  const topicList=el('nav',{id:'memory-topics',class:'memory-topics','aria-label':'Memory topics'});
  const count=el('h2',{id:'memory-facts-title',text:'Small memories'});
  const add=button('+ Add',()=>track(openEditor(null)),{id:'memory-add',class:'memory-add',disabled:true});
  const searchInput=el('input',{id:'memory-search',type:'search',placeholder:'Find a memory…',maxLength:500,'aria-label':'Find a memory'});
  const searchButton=el('button',{type:'submit',text:'Search',class:'memory-search-button'});
  const searchForm=el('form',{id:'memory-search-form',class:'memory-search-form',role:'search'},searchInput,searchButton);
  const resultsLabel=el('p',{id:'memory-status',class:'memory-meta',role:'status','aria-live':'polite'});
  const list=el('div',{id:'memory-list',class:'memory-grid'});
  const more=button('Show more memories',()=>{state.shown+=12;renderCards();},{id:'memory-more',class:'memory-secondary',hidden:true});
  const facts=el('section',{class:'memory-facts','aria-labelledby':'memory-facts-title'},el('div',{class:'memory-section-heading'},count,add),topicList,searchForm,resultsLabel,list,more);
  main.append(el('p',{class:'memory-eyebrow',text:'PERSONAL. PIECE BY PIECE.'}),el('h1',{text:'Your memory.'}),el('p',{class:'memory-intro',text:'A picture of you, built from the little things.'}),notice,summarySection,facts,el('footer',{class:'memory-footer'},el('p',{text:'Private to your profile. Always yours to correct.'}),link('Conversation history','/history.html')));
  clear(root);root.setAttribute('class','memory-page');root.append(header,main);

  function dialog(id,title){const sheet=el('dialog',{id,class:'memory-sheet','aria-labelledby':id+'-title'});const closeButton=button('Close',()=>closeDialog(sheet),{class:'memory-text-button','aria-label':'Close '+title});sheet.append(el('div',{class:'memory-sheet-heading'},el('h2',{id:id+'-title',text:title}),closeButton));sheet.addEventListener('cancel',()=>{if(sheet===previewDialog)state.confirmation=null;});sheet.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeDialog(sheet);}});root.append(sheet);return sheet;}
  const editorDialog=dialog('memory-editor','A small memory');
  const editorHint=el('p',{id:'memory-editor-hint',class:'memory-meta'});
  const editorForm=el('form',{id:'memory-editor-form'});
  const editorText=el('textarea',{id:'memory-editor-text',required:true,maxLength:800,rows:'5',placeholder:'One thing you want Nemo to remember.'});
  const category=el('select',{id:'memory-editor-topic'});for(const key of Object.keys(TOPICS).filter(key=>!['all','forgotten'].includes(key)))category.append(el('option',{value:key,text:TOPICS[key]}));category.value='personal';
  const provenance=el('details',{class:'memory-provenance'},el('summary',{text:'Where this memory came from'}));const provenanceBody=el('p');provenance.append(provenanceBody);
  const saveButton=el('button',{type:'submit',class:'memory-primary',text:'Save memory'});
  const forgetButton=button('Stop using this memory',()=>track(preview(state.editor.id,'forget')),{class:'memory-text-button'});
  const deleteButton=button('Delete memory',()=>track(preview(state.editor.id,'delete')),{class:'memory-danger'});
  editorForm.append(el('label',{for:'memory-editor-text',text:'Memory'}),editorText,el('label',{for:'memory-editor-topic',text:'Topic'}),category,saveButton);
  editorDialog.append(editorHint,editorForm,provenance,el('div',{class:'memory-sheet-actions'},forgetButton,deleteButton));
  const pickerDialog=dialog('memory-picker','Choose a memory to correct');const pickerList=el('div',{class:'memory-picker-list'});pickerDialog.append(el('p',{class:'memory-meta',text:'The summary comes from these memories. Correct the fact and the summary follows.'}),pickerList);
  const previewDialog=dialog('memory-preview','Review this change');
  const previewText=el('p',{id:'memory-preview-text'}),previewResiduals=el('ul',{class:'memory-meta'});
  const confirmButton=button('Confirm delete',()=>track(confirmDelete()),{id:'memory-confirm-delete',class:'memory-danger'});
  previewDialog.append(previewText,previewResiduals,el('div',{class:'memory-sheet-actions'},button('Cancel',()=>closeDialog(previewDialog),{class:'memory-secondary'}),confirmButton));
  const settingsDialog=dialog('memory-settings','Memory settings');
  const settingsLearning=el('input',{id:'memory-learning',type:'checkbox'});
  const learningStatus=el('p',{id:'memory-learning-status',class:'memory-meta'});
  const gmailBox=el('input',{id:'memory-gmail-source',type:'checkbox'});
  const sourceStatus=el('p',{id:'memory-source-status',class:'memory-meta'});
  const enable=button('Enable local memory',()=>track(action(async()=>{await request('/api/memory/enable',{});await refresh();})),{id:'memory-enable',class:'memory-primary',hidden:true});
  const referencesButton=button('View email references',()=>openReferences(),{class:'memory-secondary'});
  const diagnostics=el('details',{class:'memory-diagnostics'},el('summary',{text:'Storage & processing'}),el('p',{text:'Memories and their search vectors are stored on this PC in a separate GBrain database for your profile. Hermes’s memory-review guidance runs through a local Ollama model. Retrieved memories are shared with the chat model only when Connections is allowed.'}),el('p',{text:'The summary is drawn from active small memories. Email references and conversations are separate; calendar events are never memories. Stop using hides a fact from recall but keeps a recoverable copy. Delete removes the app record; previous exports, backups and provider copies can remain. Deleting does not erase original email or conversation history.'}));
  settingsDialog.append(enable,el('label',{class:'memory-setting'},el('span',{text:'Learn from my conversations'}),settingsLearning),el('p',{class:'memory-meta',text:'Automatically keep useful, lasting details you tell Nemo. You can edit them here or turn learning off.'}),learningStatus,el('label',{class:'memory-setting'},el('span',{text:'Keep email references locally'}),gmailBox),el('p',{class:'memory-meta',text:'Optional Gmail snippets help with recall. They do not become facts in your summary.'}),sourceStatus,referencesButton,link('Gmail connection & sync','/gmail-connect.html'),diagnostics,button('Delete all small memories',()=>track(preview(null,'delete',true)),{class:'memory-danger'}));
  const referencesDialog=dialog('memory-references','Email references');const referencesList=el('div',{class:'memory-reference-list'});referencesDialog.append(el('p',{class:'memory-meta',text:'Synced snippets, kept apart from what Nemo knows about you. Manage the original cache in Gmail Sync.'}),referencesList);

  function message(text){notice.textContent=text||'';notice.hidden=!text;}
  function openDialog(sheet,focus){opener=doc.activeElement;sheet.showModal?sheet.showModal():sheet.setAttribute('open','');focus?.focus?.();}
  function closeDialog(sheet){if(sheet.open)sheet.close?sheet.close():sheet.removeAttribute('open');if(sheet===previewDialog)state.confirmation=null;opener?.focus?.();}
  async function request(path,body){const response=await fetchImpl(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(180_000),headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','X-Nemo-Request':'1'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok||value.ok===false)throw new Error(response.status===401?'Sign in to your personal Nemo profile on the chat page first.':value.error||'Nemo could not complete this action. Try again.');return value;}
  async function action(work){try{return await work();}catch(error){message(error.message);throw error;}}
  function renderSummary(){
    clear(summaryBody);const summary=state.board.summary;
    if(!summary.segments.length)summaryBody.append(el('p',{class:'memory-summary-empty',text:state.board.connected?'A little more you, with every conversation.':'A place for the things worth remembering.'}));
    else{const paragraph=el('p');for(const [index,segment]of summary.segments.entries()){if(index)paragraph.append(doc.createTextNode?doc.createTextNode(' '):el('span',{text:' '}));paragraph.append(el('span',{'data-memory-id':segment.id,'data-memory-revision':segment.revision,text:segment.text}));}summaryBody.append(paragraph);}
    summaryMeta.textContent=summary.totalCount?`Drawn from ${summary.sourceCount} small ${summary.sourceCount===1?'memory':'memories'}${summary.truncated?` · ${summary.totalCount} saved in total`:''}.`:'Your summary grows from saved memories.';
    summaryEdit.disabled=!summary.segments.length;
  }
  function renderTopics(){clear(topicList);const present=key=>key==='all'||state.board.items.some(item=>key==='forgotten'?item.status==='forgotten':item.status!=='forgotten'&&item.category===key);if(!present(state.topic))state.topic='all';for(const [key,label]of Object.entries(TOPICS)){if(!present(key))continue;topicList.append(button(label,()=>{state.topic=key;state.shown=12;renderTopics();renderCards();},{class:'memory-topic','aria-pressed':String(key===state.topic)}));}}
  function renderCards(override){
    clear(list);let items=override||state.board.items;
    items=items.filter(item=>state.topic==='forgotten'?item.status==='forgotten':item.status!=='forgotten'&&(state.topic==='all'||item.category===state.topic));
    if(!override&&state.query)items=items.filter(item=>(item.text+' '+item.title).toLowerCase().includes(state.query.toLowerCase()));
    count.textContent=`Small memories (${state.board.items.filter(item=>item.status!=='forgotten').length})`;
    for(const item of items.slice(0,state.shown)){
      const open=button(item.text||item.title,()=>track(openEditor(item.id)),{class:'memory-card-open','aria-label':'Edit memory: '+(item.text||item.title)});
      const options=button('↗',()=>track(openEditor(item.id)),{class:'memory-card-options','aria-label':'Memory details: '+item.title});
      list.append(el('article',{class:'memory-card memory-card-'+(item.category||'personal'),'data-memory-id':item.id},el('div',{class:'memory-card-top'},el('span',{class:'memory-card-topic',text:TOPICS[item.category]||'Memory'}),options),open,el('p',{class:'memory-card-source',text:item.status==='forgotten'?'Not used for recall':item.corrected?'Corrected by you':item.sourceLabel||'Saved by you'})));
    }
    if(!items.length)list.append(el('p',{class:'memory-empty',text:state.query?'No matching memories. Try different words.':state.topic==='forgotten'?'No memories are paused.':'Nothing here yet. Add a memory, or let Nemo learn as you talk.'}));
    more.hidden=items.length<=state.shown;resultsLabel.textContent=override?'Matches from local meaning-based search.':state.board.hasMore?'Showing part of the memory collection.':state.query?`${items.length} matching ${items.length===1?'memory':'memories'}.`:'';
  }
  async function refresh(){
    const sequence=++state.sequence;const board=await request('/api/memory/board');if(sequence!==state.sequence)return;state.board=board;if(typeof board.notice==='string')message(board.notice);add.disabled=!board.connected;enable.hidden=board.connected;settingsLearning.disabled=!board.connected;gmailBox.disabled=!board.connected;settingsLearning.checked=board.learning.enabled;learningStatus.textContent=board.learning.error||(board.learning.busy?'Remembering the useful parts of your conversation…':board.learning.enabled?'Learning stays on this PC.':'Automatic learning is paused.');renderSummary();renderTopics();renderCards();
    clearTimeout(refreshTimer);if(board.learning.busy)refreshTimer=setTimeout(()=>track(refresh()),4000);
    const sources=await request('/api/memory/mirror');if(sequence!==state.sequence)return;gmailBox.checked=sources.sources.gmail===true;sourceStatus.textContent=`${board.references.gmail.length} saved email references${sources.syncing?' · Updating…':''}`;if(sources.initializing||sources.syncing){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>track(refresh()),3000);}
  }
  async function openEditor(id,selection){
    message('');let item=null,detail=null;
    if(id){detail=await request('/api/memory/fact?id='+encodeURIComponent(id));item=detail.item;if(selection&&item.revision!==selection.revision){await refresh();throw new Error('That memory changed. Select the summary text again.');}}
    state.editor={id:item?.id||'',revision:item?.revision||'',selectedText:selection?.text||'',forgotten:item?.status==='forgotten'};
    editorText.value=item?.content||'';editorText.maxLength=Math.max(800,editorText.value.length);category.value=state.board?.items.find(value=>value.id===id)?.category||'personal';
    editorHint.textContent=selection?'Correct the underlying memory. Your summary updates when you save.':'Keep one clear thought in each memory.';
    provenance.hidden=!item;provenanceBody.textContent=detail?.evidence?`${detail.sourceLabel}: “${detail.evidence}”`:item?'Saved in your private memory on this PC.':'';
    forgetButton.hidden=!item||state.editor.forgotten;deleteButton.hidden=!item;saveButton.hidden=state.editor.forgotten;editorText.disabled=state.editor.forgotten;category.disabled=state.editor.forgotten;
    openDialog(editorDialog,editorText);
  }
  function chooseSummary(segments){
    const selected=Array.from(new Map(segments.map(item=>[item.id,item])).values());if(!selected.length)return;
    if(selected.length===1){track(openEditor(selected[0].id,selected[0]));return;}
    clear(pickerList);for(const segment of selected)pickerList.append(button(segment.text,()=>{closeDialog(pickerDialog);track(openEditor(segment.id,segment));},{class:'memory-picker-item'}));openDialog(pickerDialog);
  }
  async function preview(id,action,all=false){
    const value=await request(all?'/api/memory/clear/preview':'/api/memory/delete/preview',all?{scope:'notes'}:{id,action});state.confirmation={...value,action};previewText.textContent=value.summary;clear(previewResiduals);for(const text of value.residuals||[])previewResiduals.append(el('li',{text}));confirmButton.textContent=action==='forget'?'Stop using memory':'Confirm delete';confirmButton.disabled=false;openDialog(previewDialog,confirmButton);
  }
  async function confirmDelete(){
    const entry=state.confirmation;if(!entry||state.deleting)return;
    if(Date.now()>=Number(entry.expiresAt)){state.confirmation=null;confirmButton.disabled=true;message('This review expired. Review the change again.');return;}
    state.deleting=true;confirmButton.disabled=true;state.confirmation=null;
    try{const value=await request('/api/memory/delete',{confirmation:entry.confirmation});closeDialog(previewDialog);closeDialog(editorDialog);message(value.receipt.state==='incomplete'?'Some memories remain. '+value.receipt.message:value.receipt.message);await refresh();}finally{state.deleting=false;}
  }
  editorForm.addEventListener('submit',event=>{event.preventDefault();if(state.saving||!editorText.value.trim())return;state.saving=true;saveButton.disabled=true;track((async()=>{try{const current=state.editor;const content=editorText.value.trim();let value;if(current.selectedText)value=await request('/api/memory/correct',{id:current.id,revision:current.revision,selectedText:current.selectedText,content});else value=await request(current.id?'/api/memory/edit':'/api/memory/notes',{...(current.id?{id:current.id,revision:current.revision}:{}),title:shortTitle(content),content,category:category.value});closeDialog(editorDialog);message(value.notice||'Memory saved. Your summary is up to date.');await refresh();}finally{state.saving=false;saveButton.disabled=false;}})());});
  searchForm.addEventListener('submit',event=>{event.preventDefault();state.query=searchInput.value.trim();state.shown=12;renderCards();if(!state.query)return;track((async()=>{const result=await request('/api/memory/semantic?'+new URLSearchParams({query:state.query,source:'notes'}));const cards=result.items.map(item=>state.board.items.find(card=>card.id===`gbrain:${item.slug}`)).filter(Boolean);renderCards(cards);})());});
  settingsLearning.addEventListener('change',()=>track((async()=>{settingsLearning.disabled=true;try{await request('/api/memory/learning',{enabled:settingsLearning.checked});await refresh();}finally{settingsLearning.disabled=false;}})()));
  gmailBox.addEventListener('change',()=>track((async()=>{gmailBox.disabled=true;try{await request('/api/memory/mirror',{gmail:gmailBox.checked,calendar:false});await refresh();}finally{gmailBox.disabled=false;}})()));
  function openReferences(){clear(referencesList);const items=state.board?.references.gmail||[];if(!items.length)referencesList.append(el('p',{text:'No email references are stored.'}));for(const item of items)referencesList.append(el('details',{},el('summary',{text:item.title}),el('p',{text:item.text}),button('Remove reference',()=>track(preview(item.id,'delete')),{class:'memory-danger'})));openDialog(referencesDialog);}
  doc.addEventListener?.('selectionchange',()=>{const selection=doc.defaultView?.getSelection?.();state.selection=[];if(selection&&!selection.isCollapsed&&selection.rangeCount){const range=selection.getRangeAt(0);for(const span of summaryBody.querySelectorAll?.('[data-memory-id]')||[]){try{if(range.intersectsNode(span)){const segment=state.board.summary.segments.find(item=>item.id===span.getAttribute('data-memory-id'));if(segment)state.selection.push(segment);}}catch{}}}selectionButton.hidden=!state.selection.length;});
  doc.addEventListener?.('visibilitychange',()=>{if(doc.visibilityState==='visible')track(refresh());});
  const ready=track(refresh());return{ready,idle:()=>idle,refresh:()=>track(refresh()),state,chooseSummary};
}
if(typeof window!=='undefined'&&window.document){const start=async()=>{const root=document.getElementById('memory-root');try{const bound=await getProfileMemoryFetch();createMemoryApp(document,bound);}catch(error){root.textContent=error.message;const link=document.createElement('a');link.href='/';link.textContent=' Open Nemo to sign in';root.append(link);}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();}

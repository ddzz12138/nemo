(() => {
  'use strict';
  const $=id=>document.getElementById(id),child=new URLSearchParams(window.location.search).get('child'),content=$('reviewContent'),status=$('reviewStatus');let version=0;
  const valid=typeof child==='string'&&/^[a-f0-9-]{36}$/.test(child);
  function node(tag,text,className){const element=document.createElement(tag);element.textContent=text||'';if(className)element.className=className;return element;}
  async function api(kind,id,source){const response=await window.nemoFetch(`/api/family/review/${child}/${kind}${id?'/'+source+'/'+id:''}`);const data=await response.json();if(!response.ok)throw new Error(data.error||'This family review is not available.');return data;}
  async function load(kind,id,source){const current=++version;content.replaceChildren();status.textContent='Opening the review…';status.dataset.error='false';try{if(!valid)throw new Error('Choose a child profile from Family.');const data=await api(kind,id,source);if(current!==version)return;$('reviewTitle').textContent=data.review.child.name+'’s '+(kind==='memory'?'Memory.':'history.');status.textContent='Read only · This review is recorded for the child.';
    if(kind==='memory'){
      const summary=node('section','','profile-card');summary.append(node('h2','Memory summary'));summary.append(node('p',data.summary?.segments?.map(segment=>segment.text).join(' ')||'No personal memories saved.'));content.append(summary);
      for(const fact of data.items||[]){const card=node('section','','profile-card');card.append(node('h2',fact.title||'Memory'),node('p',fact.text||fact.summary||''));content.append(card);}
    }else if(id){for(const message of data.messages||[]){const card=node('section','','history-message');card.append(node('strong',message.role==='user'?'Child':'Nemo'),node('p',message.text,'history-content'));content.append(card);}}
    else{for(const conversation of data.conversations||[]){const card=node('section','','profile-card');card.append(node('h2',conversation.title||'Conversation'),node('p',conversation.source==='native'?'Native preview reply':'Main chat'));const action=node('button','View conversation');action.type='button';action.addEventListener('click',()=>void load('history',conversation.id,conversation.source));const actions=node('div','','profile-actions');actions.append(action);card.append(actions);content.append(card);}if(!data.conversations?.length)content.append(node('p','No saved conversations.'));}
  }catch(error){if(current!==version)return;content.replaceChildren();status.textContent=error.message;status.dataset.error='true';}}
  $('reviewHistory').addEventListener('click',()=>void load('history'));$('reviewMemory').addEventListener('click',()=>void load('memory'));window.addEventListener('pagehide',()=>{version++;content.replaceChildren();});void load('history');
})();

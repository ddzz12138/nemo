/* Shared by Chat and History. Only text nodes render projected activity. */
(() => {
  const expanded=new Map();
  const node=(tag,text,className)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el;};
  function render(parent,activity) {
    let details=parent.querySelector(':scope > .activity-log');
    if(!activity||activity.version!==1||!Array.isArray(activity.entries)){details?.remove();return;}
    if(!details){details=node('details',null,'activity-log');details.append(node('summary'),node('ol'));details.dataset.runId=String(activity.runId||'');details.open=expanded.get(details.dataset.runId)===true;details.addEventListener('toggle',()=>{expanded.set(details.dataset.runId,details.open);if(expanded.size>100)expanded.delete(expanded.keys().next().value);});parent.append(details);}
    details.dataset.pending=String(activity.pending===true);details.dataset.attention=String(activity.attention===true);
    const title=String(activity.summary||'Activity');const summary=details.querySelector('summary');summary.setAttribute('aria-live','polite');summary.setAttribute('aria-atomic','true');if(summary.textContent!==title)summary.textContent=title;
    const list=details.querySelector('ol');const old=new Map([...list.children].map(el=>[el.dataset.id,el]));
    for(const entry of activity.entries.slice(-64)) {
      const id=String(entry.id);let row=old.get(id);old.delete(id);
      if(!row){row=node('li');row.dataset.id=id;row.append(node('span',null,'activity-symbol'),node('span',null,'activity-label'),node('span',null,'activity-duration'));}
      row.dataset.state=entry.state;
      row.children[0].textContent=entry.state==='running'?'●':['failed','partial','interrupted'].includes(entry.state)?'!':['skipped','cancelled'].includes(entry.state)?'–':'✓';
      row.children[0].setAttribute('aria-hidden','true');
      const suffix=entry.state==='interrupted'?' · interrupted':entry.state==='failed'&&!String(entry.label).includes('failed')?' · failed':'';
      const label=String(entry.label||'Activity')+suffix;if(row.children[1].textContent!==label)row.children[1].textContent=label;
      row.children[2].textContent=Number.isFinite(entry.durationMs)&&entry.durationMs>=1000?`${Math.round(entry.durationMs/1000)}s`:'';
      list.append(row);
    }
    for(const row of old.values())row.remove();
    if(!list.children.length){const row=node('li','Waiting for Hermes…');list.append(row);}
  }
  window.NemoActivity={render};
})();

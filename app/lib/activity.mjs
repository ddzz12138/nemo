// Public activity is an allowlisted projection, never an agent transcript.
export const THINKING_WORDS = Object.freeze(['pondering','contemplating','musing','cogitating','ruminating','deliberating','mulling','reflecting','processing','reasoning','analyzing','computing','synthesizing','formulating','brainstorming']);
const tools = {
  notice_read: ['Reading selected notice…', 'Selected notice read', 'Notice read failed'],
  notice_extract: ['Extracting actions locally…', 'Local extraction complete', 'Local extraction failed'],
  notice_check: ['Checking quotations and dates…', 'Quotations and dates checked', 'Notice checks failed'],
  clarify: ['Asking you…', 'Question tool finished', 'Question tool failed'],
  todo_list: ['Updating the checklist…', 'Checklist tool finished', 'Checklist tool failed'],
  mcp__nemo__gmail_search: ['Searching Gmail…', 'Gmail search complete', 'Gmail search failed'],
  mcp__nemo__calendar_list: ['Reading calendar…', 'Calendar read complete', 'Calendar read failed'],
  mcp__nemo__memory_search: ['Searching memories…', 'Memory search complete', 'Memory search failed'],
};
const memory = { queued:'Memory review queued', reviewing:'Reviewing memories locally…', waiting:'Waiting to save memories…', saving:'Saving memories locally…', unchanged:'No new memories', skipped:'Memory review skipped', disabled:'Automatic memory learning is off', cancelled:'Memory review paused or cancelled', failed:'Memory review failed', partial:'Memory changes incomplete · check Memory', interrupted:'Memory review interrupted' };
export function createActivity(runId) { return { version:1, runId, replyDone:false, pending:true, attention:false, summary:'Queued on your PC', entries:[], nextId:1 }; }
function finish(entry, state, now) { entry.state=state; entry.finishedAt=now; entry.durationMs=Math.max(0,now-entry.startedAt); }
export function recordActivity(activity, event, now=Date.now()) {
  if (!activity || activity.version!==1 || !event) return false;
  let key, label, state=event.state || 'running', kind=event.kind;
  if (kind==='thinking') {
    if (state==='completed') { for(const e of activity.entries) if(e.kind==='thinking'&&e.state==='running')finish(e,'completed',now); update(activity); return true; }
    const word=THINKING_WORDS.includes(event.verb)?event.verb:'working'; label=word[0].toUpperCase()+word.slice(1)+'…'; key='thinking';
  } else if (kind==='answer') { key='answer'; label='Preparing your answer…'; }
  else if (kind==='tool') {
    if(!tools[event.name] || typeof event.key!=='string' || !/^[A-Za-z0-9_-]{1,180}$/.test(event.key) || !['running','completed','failed'].includes(state)) return false;
    key='tool:'+event.key; label=tools[event.name][state==='running'?0:state==='completed'?1:2];
  } else if(kind==='memory') {
    if(event.phase==='saved') {
      const added=Number.isSafeInteger(event.added)&&event.added>=0?Math.min(event.added,3):0;
      const updated=Number.isSafeInteger(event.updated)&&event.updated>=0?Math.min(event.updated,3):0;
      if(!added&&!updated)return false;
      label=added&&updated?`${added} ${added===1?'memory':'memories'} saved · ${updated} updated`:added?`${added} ${added===1?'memory':'memories'} saved`:`${updated} ${updated===1?'memory':'memories'} updated`;
    } else label=memory[event.phase];
    if(!label)return false;
    state=['queued','reviewing','waiting','saving'].includes(event.phase)?'running':['failed','partial','interrupted'].includes(event.phase)?event.phase:event.phase==='cancelled'?'cancelled':event.phase==='skipped'||event.phase==='disabled'?'skipped':'completed';
    key='memory';
  } else if(kind==='run') {
    if(state==='running'){activity.summary='Starting Hermes…';return true;}
    if(!['completed','failed','interrupted'].includes(state))return false;
    activity.replyDone=true;
    for(const e of activity.entries)if(e.state==='running'&&e.kind!=='memory'){finish(e,state==='completed'?'completed':state,now);if(e.kind==='answer'&&state==='completed')e.label='Answer ready';}
    if(state!=='completed') { key='run';label=state==='failed'?'Reply failed':'Reply interrupted'; }
    else { update(activity);return true; }
  } else return false;
  if(kind==='thinking'||kind==='tool'||kind==='answer')for(const e of activity.entries)if(['thinking','answer'].includes(e.kind)&&e.state==='running'&&!(e.key===key&&e.label===label))finish(e,'completed',now);
  let entry=activity.entries.findLast(e=>e.key===key && (e.state==='running' || kind==='tool'));
  if(entry&&entry.label===label&&entry.state===state&&state==='running')return false;
  if(kind==='memory'&&entry&&entry.label!==label){finish(entry,'completed',now);entry=null;}
  if(!entry) {
    // One run has at most six tool calls and eight model turns. This cap also
    // bounds unexpected repeated callbacks without losing later terminal states.
    if(activity.entries.length>=64){const index=activity.entries.findIndex(e=>e.state!=='running');if(index<0)return false;activity.entries.splice(index,1);}
    entry={id:activity.nextId++,key,kind,label,state,startedAt:now};activity.entries.push(entry);
  } else {entry.label=label;entry.state=state;}
  if(state!=='running')finish(entry,state,now);
  update(activity);return true;
}
function update(a){a.pending=!a.replyDone||a.entries.some(e=>e.state==='running');a.attention=a.entries.some(e=>['failed','partial','interrupted'].includes(e.state));a.summary=a.pending?(a.entries.findLast(e=>e.state==='running')?.label||'Hermes is working…'):a.attention?'Activity · needs attention':'Activity · complete';}
export function interruptActivity(a, now=Date.now()){if(!a?.pending)return;for(const e of a.entries)if(e.state==='running'){finish(e,'interrupted',now);if(e.kind==='memory')e.label=memory.interrupted;}recordActivity(a,{kind:'run',state:'interrupted'},now);}
export function publicActivity(a){if(!a||a.version!==1)return undefined;return{version:1,runId:a.runId,pending:a.pending,attention:a.attention,summary:a.summary,entries:a.entries.map(({id,kind,label,state,startedAt,finishedAt,durationMs})=>({id,kind,label,state,startedAt,...(finishedAt!==undefined?{finishedAt,durationMs}:{})}))};}

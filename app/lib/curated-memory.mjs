import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {MemoryError} from './memory.mjs';
import {createLocalMemoryReviewer,MEMORY_CATEGORIES,meaningfulMemoryInput} from './local-memory-review.mjs';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const normalize=value=>String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const factHash=value=>hash(normalize(value));
const fail=(status,message,code='MEMORY')=>{throw new MemoryError(status,message,code);};
const note=page=>page?.slug?.startsWith('nemo-notes/')&&!page.slug.startsWith('nemo-notes/gmail/')&&!page.slug.startsWith('nemo-notes/calendar/');
const textOf=page=>(page.content||page.summary||page.title||'').trim();
const titleOf=text=>text.replace(/\s+/g,' ').slice(0,90);
export const memorySummaryText=text=>String(text).replace(/^#{1,6}\s+/gm,'').replace(/^[-*]\s+/gm,'').replace(/\s+/g,' ').trim().slice(0,360);
function categoryFor(page,metadata){
  if(MEMORY_CATEGORIES.includes(metadata?.category))return metadata.category;
  const text=page.title+' '+textOf(page);
  if(/\b(prefer|like|dislike|favourite|favorite|style|concise|detailed)\b/i.test(text))return'preferences';
  if(/\b(project|building|working on|develop|startup|business|app|nemo)\b/i.test(text))return'projects';
  if(/\b(friend|partner|family|mother|father|brother|sister|daughter|son|wife|husband)\b/i.test(text))return'people';
  return'personal';
}
export async function createCuratedMemory({dataDir,profileId,controller,gbrain,engine=()=>({connected:true}),assertIdle=()=>{},reviewer=createLocalMemoryReviewer(),now=Date.now}={}){
  const path=join(dataDir,'memory-learning.json');let state;
  try{state=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new MemoryError(503,'Memory settings could not be read.');state={version:1,enabled:false,records:{},blocked:[],reviewed:[]};}
  if(state.version!==1||typeof state.enabled!=='boolean'||!state.records||Array.isArray(state.records)||!Array.isArray(state.blocked)||!Array.isArray(state.reviewed)||state.blocked.length>20_000)throw new MemoryError(503,'Memory settings could not be read.');
  let chain=Promise.resolve(),job=null,epoch=0,error=null,closed=false,abort=null,cache=null;const queue=[];const confirmations=new Map();
  const serial=operation=>{const work=chain.catch(()=>{}).then(operation);chain=work.catch(()=>{});return work;};
  const notify=(entry,phase)=>{try{entry.onActivity?.({kind:'memory',phase,added:entry.added||0,updated:entry.updated||0});}catch{/* UI observers cannot change memory execution. */}};
  const cancelled=entry=>{notify(entry,entry.added||entry.updated?'partial':'cancelled');};
  const discardQueue=()=>{for(const entry of queue.splice(0))cancelled(entry);};
  async function persist(){const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}}
  function check(owner){if(owner!==profileId)fail(403,'This memory belongs to a different profile.');}
  const status=()=>({enabled:state.enabled,processing:'local',busy:!!job||queue.length>0,model:reviewer.model||'local',lastLearnedAt:state.lastLearnedAt||null,...(error?{error}:{}),calendarIncluded:false});
  async function inventory(force=false){
    if(!force&&cache&&now()-cache.at<3000)return cache.value;
    if(!engine().connected)return{connected:false,pages:[],hasMore:false};
    const pages=[];let offset=0,hasMore=false;
    try{for(let n=0;n<20;n++){const page=await gbrain.list({limit:100,offset});if(!page||!Array.isArray(page.items))throw Error();pages.push(...page.items.filter(item=>item?.slug?.startsWith('nemo-notes/')&&!item.slug.startsWith('nemo-notes/calendar/')));offset+=page.items.length;hasMore=page.hasMore===true;if(!hasMore||!page.items.length)break;}}
    catch{fail(503,'Your memories could not be read. Try again.','MEMORY_UNAVAILABLE');}
    const value={connected:true,pages,hasMore};cache={at:now(),value};return value;
  }
  function card(page){const meta=state.records[page.slug];return{id:`gbrain:${page.slug}`,title:page.title,text:textOf(page),revision:page.revision,status:page.status==='forgotten'?'forgotten':'active',category:categoryFor(page,meta),source:meta?.origin==='conversation'?'conversation':'saved',sourceLabel:meta?.origin==='conversation'?'From a conversation':'Saved by you',updatedAt:page.updatedAt||meta?.updatedAt||null,corrected:meta?.corrected===true};}
  async function board(owner){
    check(owner);const data=await inventory();const facts=data.pages.filter(note);facts.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
    const active=facts.filter(page=>page.status!=='forgotten');const summaryPages=active.slice(0,8);let full=[];
    if(summaryPages.length&&typeof gbrain.getMany==='function')try{full=await gbrain.getMany(summaryPages.map(p=>p.slug));}catch{fail(503,'The memory summary could not be verified. Try again.');}
    const current=new Map(full.map(p=>[p.slug,p]));let budget=1375;const segments=[];
    for(const listed of summaryPages){const page=current.get(listed.slug)||listed;if(page.status==='forgotten')continue;const text=memorySummaryText(textOf(page));if(!text||text.length>budget)continue;segments.push({id:`gbrain:${page.slug}`,text,revision:page.revision,category:categoryFor(page,state.records[page.slug])});budget-=text.length+1;}
    const items=facts.map(card);
    return{ok:true,connected:data.connected,items,hasMore:data.hasMore,summary:{segments,sourceCount:segments.length,totalCount:active.length,truncated:segments.length<active.length||data.hasMore,revision:hash(JSON.stringify(segments))},learning:status(),references:{gmail:data.pages.filter(page=>page.slug.startsWith('nemo-notes/gmail/')).map(page=>({id:`gbrain:${page.slug}`,title:page.title,text:textOf(page),revision:page.revision,status:page.status}))}};
  }
  function block(page){
    const meta=state.records[page.slug];for(const value of [factHash(textOf(page)),...(meta?.key?[hash('key:'+meta.key)]:[])])if(!state.blocked.includes(value))state.blocked.push(value);
    if(state.blocked.length>=20_000){state.enabled=false;error='Automatic learning is paused to preserve your deleted-memory exclusions.';}
  }
  async function saveLocked(owner,input,edit){
    check(owner);epoch++;abort?.abort();
    const category=input.category;const clean={...input};delete clean.category;
    if(category!==undefined&&!MEMORY_CATEGORIES.includes(category))fail(400,'Choose a valid memory topic.');
    let old=null;if(edit){old=await gbrain.get(String(input.id).slice(7));if(!note(old))fail(400,'Email references follow their source. Add a separate memory to correct what Nemo knows.');}
    const result=await controller.save(owner,clean,edit);const slug=result.item.id.slice(7);if(old)block(old);
    const previous=state.records[slug]||{};
    state.records[slug]={origin:'manual',category:category||previous.category||categoryFor(result.item),key:previous.key,locked:true,corrected:edit,updatedAt:new Date(now()).toISOString()};
    cache=null;await persist();return result;
  }
  async function preview(owner,input,clear=false){
    check(owner);const result=await controller.preview(owner,input,clear);
    const data=await inventory(true);const selected=clear?data.pages.filter(page=>input.scope==='notes'?note(page):input.scope==='gbrain'||input.scope==='all'):data.pages.filter(page=>`gbrain:${page.slug}`===input.id);
    confirmations.set(result.confirmation,{pages:selected,expiresAt:result.expiresAt,action:clear?'delete':input.action});for(const [token,entry]of confirmations)if(entry.expiresAt<=now())confirmations.delete(token);
    while(confirmations.size>100)confirmations.delete(confirmations.keys().next().value);return result;
  }
  async function removeLocked(owner,input){
    check(owner);epoch++;abort?.abort();const preview=confirmations.get(input.confirmation);const result=await controller.remove(owner,input);confirmations.delete(input.confirmation);cache=null;
    if(result.receipt?.state==='complete'&&preview){for(const page of preview.pages){block(page);if(preview.action==='delete')delete state.records[page.slug];}await persist();}
    return result;
  }
  async function correct(owner,input){return serial(async()=>{
    check(owner);if(!input||Object.keys(input).some(k=>!['id','revision','selectedText','content'].includes(k))||typeof input.selectedText!=='string'||!input.selectedText.trim())fail(400,'Select the memory text you want to correct.');
    const page=await gbrain.get(String(input.id).slice(7));if(!note(page)||page.status==='forgotten')fail(400,'Choose an active memory.');
    if(page.revision!==input.revision||!memorySummaryText(textOf(page)).includes(input.selectedText))fail(409,'That summary changed. Select the text again.','MEMORY_CHANGED');
    return saveLocked(owner,{id:input.id,revision:input.revision,title:titleOf(String(input.content||'')),content:input.content},true);
  });}
  async function learn(entry,version){
    if(closed||!state.enabled||version!==epoch){cancelled(entry);return;}
    notify(entry,'reviewing');
    const before=await inventory(true);const existing=before.pages.filter(note);const known=existing.filter(p=>p.status!=='forgotten').map(p=>({key:state.records[p.slug]?.key||'',text:textOf(p)}));
    if(!before.connected)throw Error('disconnected');
    abort=new AbortController();const facts=await reviewer.review({text:entry.text,known,signal:abort.signal});
    for(const fact of facts){
      if(closed||!state.enabled||version!==epoch){cancelled(entry);return;}
      let idle=false;for(let attempt=0;attempt<45;attempt++){try{assertIdle();idle=true;break;}catch{}if(attempt===0)notify(entry,'waiting');await new Promise(resolve=>{const timer=setTimeout(resolve,2000);timer.unref?.();});if(closed||version!==epoch){cancelled(entry);return;}}
      if(!idle)throw Error('busy');
      await serial(async()=>{
        if(closed||!state.enabled||version!==epoch)return;
        const data=await inventory(true);const notes=data.pages.filter(note);const fingerprint=factHash(fact.text),keyHash=hash('key:'+fact.key);
        if(state.blocked.includes(fingerprint)||state.blocked.includes(keyHash)||notes.some(p=>factHash(textOf(p))===fingerprint))return;
        const old=notes.find(p=>state.records[p.slug]?.key===fact.key);
        if(old&&(state.records[old.slug]?.locked||old.status==='forgotten'))return;
        if(notes.filter(p=>p.status!=='forgotten').length>=500)return;
        notify(entry,'saving');
        const result=await controller.save(profileId,{...(old?{id:`gbrain:${old.slug}`,revision:old.revision}:{}),title:titleOf(fact.text),content:fact.text},!!old);
        entry.storageChanged=true;
        state.records[result.item.id.slice(7)]={origin:'conversation',category:fact.category,key:fact.key,evidence:fact.evidence,turnHash:hash(entry.id),updatedAt:new Date(now()).toISOString()};
        state.lastLearnedAt=new Date(now()).toISOString();error=null;cache=null;await persist();
        if(old)entry.updated++;else entry.added++;
      });
    }
    if(closed||!state.enabled||version!==epoch){cancelled(entry);return;}
    await serial(async()=>{state.reviewed=[...state.reviewed,hash(entry.id)].slice(-500);await persist();});
    if(closed||!state.enabled||version!==epoch){cancelled(entry);return;}
    notify(entry,entry.added||entry.updated?'saved':'unchanged');
  }
  function drain(){
    if(job||closed||!queue.length)return;const entry=queue.shift();const version=epoch;
    job=learn(entry,version).catch(()=>{if(closed||!state.enabled||version!==epoch){cancelled(entry);return;}error='Some memories could not be saved. Your conversation is safe; check the local model or try again later.';notify(entry,entry.storageChanged?'partial':'failed');}).finally(()=>{job=null;abort=null;drain();});
  }
  const wrapped={...controller,save:(owner,input,edit)=>serial(()=>saveLocked(owner,input,edit)),preview,remove:(owner,input)=>serial(()=>removeLocked(owner,input))};
  return{controller:wrapped,board,correct,status,
    configure(owner,input){return serial(async()=>{check(owner);if(!input||Object.keys(input).length!==1||typeof input.enabled!=='boolean')fail(400,'Choose whether Nemo may learn from your chats.');epoch++;abort?.abort();discardQueue();state.enabled=input.enabled;error=null;await persist();return{ok:true,learning:status()};});},
    capture({id,text,onActivity}){const entry={id,text,onActivity,added:0,updated:0};if(!state.enabled){notify(entry,'disabled');return;}if(closed||!meaningfulMemoryInput(text)||state.reviewed.includes(hash(id))||queue.some(p=>p.id===id)){notify(entry,'skipped');return;}if(queue.length>=8){error='Memory learning is busy. Some conversation details may not be saved.';notify(entry,'failed');return;}queue.push(entry);notify(entry,'queued');drain();},
    async details(owner,id){check(owner);const result=await controller.get(owner,id);const metadata=state.records[String(id).slice(7)];return{...result,...(metadata?.evidence?{evidence:metadata.evidence}:{}),sourceLabel:metadata?.origin==='conversation'?'From a conversation':'Saved by you'};},
    async close(){closed=true;epoch++;abort?.abort();discardQueue();await job;await chain;},
    async idle(){await job;await chain;},
  };
}

import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error=()=>Object.assign(new Error('Source memory copies could not be synchronized. Review what remains in Memory.'),{status:503,code:'MEMORY_MIRROR'});
const copySlug=(source,id)=>`nemo-notes/${source}/${createHash('sha256').update(id).digest('hex').slice(0,32)}`;

export async function createMemoryMirror({dataDir,gbrain,gmail,calendar,now=Date.now,includeCalendar=true}) {
  const path=join(dataDir,'memory-mirror.json');
  let state;
  try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw error();state={version:1,sources:{gmail:false,calendar:false},excluded:[],fingerprints:{},counts:{gmail:0,calendar:0}};}
  if(state.version!==1||!state.sources||typeof state.sources.gmail!=='boolean'||typeof state.sources.calendar!=='boolean'||!Array.isArray(state.excluded)||state.excluded.length>10_000||state.excluded.some(value=>typeof value!=='string'||!/^nemo-notes\/(gmail|calendar)\/[a-f0-9]{32}$/.test(value)))throw error();
  state.fingerprints||={};state.counts||={gmail:0,calendar:0};
  let pending=0;let chain=Promise.resolve();let lastError=null;
  const serial=action=>{pending++;const work=chain.catch(()=>{}).then(action);chain=work.catch(()=>{});return work.finally(()=>pending--);};
  const save=async()=>{const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(state),{mode:0o600});await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}};
  const status=()=>({configured:true,sources:{...state.sources},counts:{...state.counts},lastSyncedAt:state.lastSyncedAt||null,busy:pending>0,localProcessing:true,model:'nomic-embed-text',retention:'mirror',...(lastError?{error:'Source memory sync is incomplete. Retry from Memory.'}:{})});
  async function records(source){
    if(!state.sources[source]||(source==='calendar'&&!includeCalendar))return[];
    if(source==='gmail'){
      if(typeof gmail.cachedMessages!=='function')return[];
      const cache=await gmail.cachedMessages();
      if(cache.mode!=='sync')return[];
      const account=(await gmail.status()).account||'';
      return(cache.messages||[]).slice(0,50).map(item=>({id:`${account}\0${item.id}`,title:(item.subject||'Email snippet').slice(0,160),content:`Source: Gmail snippet (a mirrored copy, not the full message).\nFrom: ${item.from}\nSubject: ${item.subject}\nDate: ${item.date}\n\n${item.snippet}`.slice(0,8000)}));
    }
    const snapshot=calendar.read({limit:200});
    if(!snapshot.connected)return[];
    return(snapshot.events||[]).map(item=>({id:item.id,title:item.title.slice(0,160),content:`Source: iPhone calendar snapshot (a mirrored copy).\nEvent: ${item.title}\nStart: ${item.start}\nEnd: ${item.end}\nAll day: ${item.allDay===true}`.slice(0,8000)}));
  }
  async function apply(source,input,force=false){
    if(!input.length&&state.sources[source]===false&&state.counts[source]===0&&typeof gbrain.isUninitialized==='function'&&await gbrain.isUninitialized())return{ok:true,source,desiredCount:0,updated:0,removed:0,uninitialized:true};
    if(typeof gbrain.mirrorCopies!=='function'){
      if(!input.length&&!state.sources[source]&&!state.counts[source])return{ok:true,source,desiredCount:0,updated:0,removed:0};
      throw error();
    }
    const selected=input.filter(record=>!state.excluded.includes(copySlug(source,record.id)));
    const fingerprint=digest(selected);
    if(!force&&state.fingerprints[source]===fingerprint)return{ok:true,source,desiredCount:state.counts[source]||0,unchanged:true};
    try{
      const result=await gbrain.mirrorCopies(source,selected,state.excluded);
      if(!result?.ok)throw error();
      state.fingerprints[source]=fingerprint;state.counts[source]=result.desiredCount;state.lastSyncedAt=new Date(now()).toISOString();lastError=null;await save();return result;
    }catch{lastError=true;throw error();}
  }
  return{
    status,
    busy:()=>pending>0,
    sync(source){if(!['gmail','calendar'].includes(source))return Promise.reject(error());if(source==='calendar'&&!includeCalendar&&state.calendarExcluded)return Promise.resolve({ok:true,source,excluded:true,desiredCount:0});return serial(async()=>apply(source,await records(source)));},
    syncAll(){return serial(async()=>{const result=[];for(const source of ['gmail','calendar']){if(source==='calendar'&&!includeCalendar&&state.calendarExcluded)continue;result.push(await apply(source,await records(source)));}return{ok:true,...status(),results:result};});},
    clear(source){if(!['gmail','calendar'].includes(source))return Promise.reject(error());if(source==='calendar'&&!includeCalendar&&state.calendarExcluded)return Promise.resolve({ok:true,source,excluded:true,desiredCount:0});return serial(()=>apply(source,[],true));},
    configure(sources){return serial(async()=>{if(!sources||typeof sources.gmail!=='boolean'||typeof sources.calendar!=='boolean'||(!includeCalendar&&sources.calendar)||Object.keys(sources).some(key=>!['gmail','calendar'].includes(key)))throw error();for(const source of ['gmail','calendar'])if(!sources[source])await apply(source,[],true);state.sources={gmail:sources.gmail,calendar:includeCalendar&&sources.calendar};state.fingerprints={};await save();return status();});},
    excludeCalendar(){return serial(async()=>{if(state.calendarExcluded===true&&!state.sources.calendar&&!state.counts.calendar)return status();await apply('calendar',[],true);state.sources.calendar=false;state.counts.calendar=0;state.calendarExcluded=true;await save();return status();});},
    exclude(slug){return serial(async()=>{if(!/^nemo-notes\/(gmail|calendar)\/[a-f0-9]{32}$/.test(slug))return;if(!state.excluded.includes(slug)){if(state.excluded.length>=10_000)throw error();state.excluded.push(slug);await save();}});},
    calendarRemoved(ids){return serial(async()=>{const additions=ids.map(id=>copySlug('calendar',id)).filter(slug=>!state.excluded.includes(slug));if(state.excluded.length+additions.length>10_000)throw error();state.excluded.push(...additions);state.fingerprints.calendar=null;await save();await apply('calendar',await records('calendar'),true);});},
  };
}

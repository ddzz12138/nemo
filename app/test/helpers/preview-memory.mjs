/* Isolated sample store for UI previews/tests. Never used by installed Nemo. */
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProfileMemory} from '../../lib/profile-memory.mjs';
import {MemoryError} from '../../lib/memory.mjs';

export async function createPreviewMemory(options){
  const file=join(options.profileDataDir,'sample-memories.json');
  await mkdir(options.profileDataDir,{recursive:true});
  let records;
  try{records=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;records=['You prefer short answers with the actions first.','You like a reminder of school deadlines.'].map((text,index)=>({slug:'nemo-notes/sample-'+index,title:text,content:text,summary:text,revision:'sample-'+index,status:'active',kind:'note'}));}
  if(!Array.isArray(records))throw new Error('The sample Memory store is invalid.');
  const store=new Map(records.map(record=>[record.slug,record]));
  const persist=async()=>{const temporary=file+'.tmp';await writeFile(temporary,JSON.stringify([...store.values()],null,2));await rename(temporary,file);};
  await persist();
  const get=async slug=>{if(!store.has(slug))throw new MemoryError(404,'Sample memory not found.');return{...store.get(slug)};};
  const gbrain={
    status:async()=>({connected:true,embedding:'sample-only',searchMode:'sample-text'}),
    list:async({offset=0,limit=100}={})=>({items:[...store.values()].slice(offset,offset+limit).map(record=>({...record})),hasMore:store.size>offset+limit}),
    get,getMany:async slugs=>Promise.all(slugs.map(get)),
    search:async({query,limit=10})=>({items:[...store.values()].filter(record=>record.status!=='forgotten'&&record.content.toLowerCase().includes(query.toLowerCase())).slice(0,limit).map(record=>({...record})),hasMore:false}),
    async save(input){const slug=input.slug||'nemo-notes/'+randomUUID(),prior=store.get(slug);if(input.expectedRevision&&input.expectedRevision!==prior?.revision)throw new MemoryError(409,'That sample memory changed. Refresh it.');const record={slug,title:input.title,content:input.content,summary:input.content,revision:randomUUID(),status:'active',kind:'note',updatedAt:new Date().toISOString()};store.set(slug,record);await persist();return{...record};},
    async forget(slug){const record=await get(slug);store.set(slug,{...record,status:'forgotten',revision:randomUUID()});await persist();return{ok:true,status:'forgotten'};},
    async remove(slug){store.delete(slug);await persist();return{ok:true,status:'purged',receipt:{completion:'complete'}};},
    async mirrorCopies(source,items){if(items.length)throw new MemoryError(503,'Connected source sync is not available in this sample preview.');for(const slug of store.keys())if(slug.startsWith('nemo-notes/'+source+'/'))store.delete(slug);await persist();return{ok:true,desiredCount:0};},
    indexPending:async()=>({ok:true}),
  };
  const memory=await createProfileMemory({...options,clientFactory:async()=>gbrain,reviewer:{model:'sample-no-inference',review:async()=>[]}});
  const board=memory.curation.board;
  memory.curation.board=async owner=>({...await board(owner),notice:'Sample preview. Changes here stay separate from your real Memory.'});
  return memory;
}

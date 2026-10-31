import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {prepareNativeHome} from './native-session.mjs';
import {readJson,writeJson} from './profile-store.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const invalid=()=>Object.assign(new Error('Live updates need reconnection. Saved tasks remain available.'),{status:503,code:'NATIVE_EVENTS'});
export function parseNativeCursor(value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>60)throw Object.assign(new Error('Use the saved live-update cursor.'),{status:400,code:'NATIVE_CURSOR'});
  const [epoch,sequence,...rest]=value.split(':');
  if(rest.length||!UUID.test(epoch)||!/^(?:0|[1-9][0-9]{0,15})$/.test(sequence)||!Number.isSafeInteger(Number(sequence)))throw Object.assign(new Error('Use the saved live-update cursor.'),{status:400,code:'NATIVE_CURSOR'});
  return{epoch,sequence:Number(sequence)};
}

/** Private invalidation journal, under the profile's task-supervisor lease.
 * It stores IDs and hashes only: no prompts, answers, tools or source contents.
 * Replayed notifications always fetch the current authenticated task view. */
export async function createNativeEventJournal({dataDir,profileId,limit=256}){
  if(!UUID.test(profileId||'')||!Number.isSafeInteger(limit)||limit<1||limit>256)throw invalid();
  const path=join(dirname(await prepareNativeHome({dataDir,profileId})),'native-events.json');
  let state=await readJson(path,{version:1,profileId,epoch:randomUUID(),nextId:1,events:[],fingerprints:{}}),chain=Promise.resolve(),closed=false;
  if(!state||Object.keys(state).some(key=>!['version','profileId','epoch','nextId','events','fingerprints'].includes(key))||state.version!==1||state.profileId!==profileId||!UUID.test(state.epoch||'')||!Number.isSafeInteger(state.nextId)||state.nextId<1||!Array.isArray(state.events)||state.events.length>256||!state.fingerprints||typeof state.fingerprints!=='object'||Array.isArray(state.fingerprints)||Object.keys(state.fingerprints).length>1000||Object.entries(state.fingerprints).some(([id,hash])=>!UUID.test(id)||!HASH.test(hash)))throw invalid();
  let previous=0;for(const event of state.events){if(!event||Object.keys(event).some(key=>!['sequence','taskId'].includes(key))||!Number.isSafeInteger(event.sequence)||event.sequence<=previous||event.sequence>=state.nextId||!UUID.test(event.taskId||''))throw invalid();previous=event.sequence;}
  const cursor=()=>state.epoch+':'+(state.nextId-1);
  async function transaction(change){
    const result=chain.catch(()=>{}).then(async()=>{if(closed)throw invalid();const before=structuredClone(state);try{const changed=change();if(changed)await writeJson(path,state);return{changed,cursor:cursor()};}catch(error){state=before;throw error;}});chain=result.then(()=>{},()=>{});return result;
  }
  return{
    publish(taskId,fingerprint){if(!UUID.test(taskId||'')||!HASH.test(fingerprint||''))return Promise.reject(invalid());return transaction(()=>{if(state.fingerprints[taskId]===fingerprint)return false;if(Object.keys(state.fingerprints).length>=1000&&!Object.hasOwn(state.fingerprints,taskId))throw invalid();if(state.nextId>=Number.MAX_SAFE_INTEGER)throw invalid();state.fingerprints[taskId]=fingerprint;state.events.push({sequence:state.nextId++,taskId});state.events=state.events.slice(-limit);return true;});},
    reset(){return transaction(()=>{state={version:1,profileId,epoch:randomUUID(),nextId:1,events:[],fingerprints:{}};return true;});},
    async read(after){const parsed=parseNativeCursor(after);await chain;if(closed)throw invalid();const current=cursor(),earliest=state.events[0]?.sequence||state.nextId;if(!parsed||parsed.epoch!==state.epoch||parsed.sequence>state.nextId-1||parsed.sequence<earliest-1)return{cursor:current,reset:true,events:[]};return{cursor:current,reset:false,events:state.events.filter(event=>event.sequence>parsed.sequence).map(event=>({cursor:state.epoch+':'+event.sequence,taskId:event.taskId}))};},
    async close(){await chain;closed=true;},
  };
}

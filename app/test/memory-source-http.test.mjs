import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createNemoServer} from '../lib/personal-gateway.mjs';
async function fixture(t){
  const dataDir=await mkdtemp(fileURLToPath(new URL('./.tmp-memory-source-http-',import.meta.url)));
  let mode='sync',fail=false;let searchCalls=0;
  const copies={gmail:[],calendar:[]};
  const gbrain={status:async()=>({connected:true,embedding:'local-ollama',searchMode:'hybrid'}),list:async()=>({items:[],hasMore:false}),search:async()=>{searchCalls++;return {items:[],hasMore:false};},indexPending:async()=>({ok:true}),mirrorCopies:async(source,records)=>{if(fail)throw Error('SENSITIVE_UPSTREAM_ERROR');copies[source]=records;return {ok:true,desiredCount:records.length};}};
  const gmail={status:async()=>({connected:true,account:'fixture.invalid'}),reload:async()=>{},syncStatus:async()=>({mode}),cachedMessages:async()=>({mode,messages:mode==='sync'?[{id:'fixture',subject:'Fixture',snippet:'Synthetic source only'}]:[]}),setSyncMode:async next=>{mode=next;return {mode};}};
  const app=await createNemoServer({dataDir,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),integrations:{gbrain,gmail},provider:{status:()=>({connected:true}),run:async()=>({text:'unused'})},pairingCode:'12345678',logger:()=>{}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='';
  const request=async(path,{method='GET',body,paired=true}={})=>{const response=await fetch(base+path,{method,headers:{...(paired?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json','X-Nemo-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  cookie=(await request('/api/pair',{method:'POST',body:{code:'12345678'}})).cookie;
  return {request,copies,searchCalls:()=>searchCalls,mode:()=>mode,fail:()=>{fail=true;}};
}
test('source and semantic endpoints need pairing and validate before retrieval',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/memory/mirror','/api/memory/semantic?query=x'])assert.equal((await f.request(path,{paired:false})).status,401);
  for(const body of [{gmail:true},{gmail:true,calendar:true,extra:true},{gmail:'yes',calendar:true}])assert.equal((await f.request('/api/memory/mirror',{method:'POST',body})).status,400);
  assert.equal((await f.request('/api/memory/semantic?query=x&source=private')).status,400);assert.equal(f.searchCalls(),0);
  const calendar=await f.request('/api/memory/semantic?query=x&source=calendar');assert.equal(calendar.status,400);assert.equal(f.searchCalls(),0);
  const search=await f.request('/api/memory/semantic?query=x&source=notes');assert.equal(search.status,200);assert.equal(search.data.processing,'local');assert.equal(f.searchCalls(),1);
});
test('Gmail clear stops sync only after source copies are removed and leaves AI consent off',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/memory/mirror',{method:'POST',body:{gmail:true,calendar:false}})).status,202);
  for(let n=0;n<50&&!f.copies.gmail.length;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.copies.gmail.length,1);
  assert.equal((await f.request('/api/integrations')).data.contextConsent,false);
  const clear=await f.request('/api/gmail/cache/clear',{method:'POST',body:{}});assert.equal(clear.status,200);assert.equal(f.mode(),'demand');assert.equal(f.copies.gmail.length,0);
});
test('failed mirrored deletion cannot silently clear cache or report success',async t=>{
  const f=await fixture(t);await f.request('/api/memory/mirror',{method:'POST',body:{gmail:true,calendar:false}});
  for(let n=0;n<50&&!f.copies.gmail.length;n++)await new Promise(resolve=>setTimeout(resolve,5));
  f.fail();const result=await f.request('/api/gmail/cache/clear',{method:'POST',body:{}});
  assert.equal(result.status,503);assert.equal(f.mode(),'sync');assert.equal(f.copies.gmail.length,1);assert.equal(JSON.stringify(result).includes('SENSITIVE_UPSTREAM_ERROR'),false);
});

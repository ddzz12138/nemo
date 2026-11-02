import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryDom,all} from './helpers/memory-dom.mjs';
const {createMemoryApp}=await import(new URL(process.env.NEMO_MEMORY_UI||'../public/memory.js',import.meta.url));
const item={id:'gbrain:nemo-notes/one',title:'Preference',text:'You prefer concise answers.',revision:'r1',status:'active',category:'preferences',sourceLabel:'Saved by you'};
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
const board=(items=[item],connected=true)=>({ok:true,connected,items,summary:{segments:items.filter(p=>p.status==='active').map(p=>({id:p.id,text:p.text,revision:p.revision})),sourceCount:items.filter(p=>p.status==='active').length,totalCount:items.length,truncated:false},learning:{enabled:true,busy:false},references:{gmail:[]}});
async function setup(handler){const f=memoryDom();const calls=[];const fetch=async(path,options)=>{calls.push({path,options});if(handler){const custom=await handler(path,options);if(custom)return custom;}if(path.startsWith('/api/memory/fact'))return response({ok:true,item:{...item,content:item.text},evidence:'I prefer concise answers.'});if(path==='/api/memory/mirror')return response({ok:true,sources:{gmail:false}});return response(board());};const app=createMemoryApp(f.doc,fetch);await app.ready;return{...f,app,calls};}
test('summary and small memories share the same visible facts while advanced controls stay in a sheet',async()=>{const f=await setup();assert.match(f.id('memory-summary').textContent,/concise answers/);assert.match(f.id('memory-list').textContent,/concise answers/);assert.equal(f.id('memory-settings').open,false);const ids=all(f.doc.body).map(node=>node.getAttribute('id')).filter(Boolean);assert.equal(new Set(ids).size,ids.length);});
test('a signed-out response does not expose a writable memory collection',async()=>{const f=await setup(path=>path==='/api/memory/board'?response({error:'AUTH'},401):null);assert.match(f.id('memory-message').textContent,/Sign in/);assert.equal(f.id('memory-add').disabled,true);assert.equal(f.id('memory-list').children.length,0);});
test('an unavailable Memory engine replaces loading copy with recovery guidance',async()=>{const f=await setup(path=>path==='/api/memory/board'?response({error:'Memory is not connected.'},503):null);assert.equal(f.id('memory-summary').textContent,'Memory is not ready yet.');assert.match(f.id('memory-summary-meta').textContent,/setup.*reload/);assert.match(f.id('memory-status').textContent,/History/);assert.equal(f.id('memory-add').disabled,true);});
test('the Add form saves once with no caller-selected profile or source identity',async()=>{let writes=0;let body;const f=await setup((path,options)=>{if(path==='/api/memory/notes'){writes++;body=JSON.parse(options.body);return response({ok:true});}});f.button('+ Add').click();await f.app.idle();f.id('memory-editor-text').value='You enjoy pottery.';f.button('Save memory').click();f.button('Save memory').click();await f.app.idle();assert.equal(writes,1);assert.equal(body.content,'You enjoy pottery.');assert.equal(body.profileId,undefined);assert.equal(body.owner,undefined);});
test('summary correction submits the exact source identifier, revision and selected memory text',async()=>{let correction;const f=await setup((path,options)=>{if(path==='/api/memory/correct'){correction=JSON.parse(options.body);return response({ok:true});}});f.app.chooseSummary([{id:item.id,revision:'r1',text:item.text}]);await f.app.idle();f.id('memory-editor-text').value='You prefer detailed answers.';f.button('Save memory').click();await f.app.idle();assert.deepEqual(correction,{id:item.id,revision:'r1',selectedText:item.text,content:'You prefer detailed answers.'});});
test('a changed revision cannot silently replace a stale highlighted summary',async()=>{const f=await setup(path=>path.startsWith('/api/memory/fact')?response({ok:true,item:{...item,content:item.text,revision:'r2'}}):null);f.app.chooseSummary([{id:item.id,revision:'r1',text:item.text}]);await f.app.idle();assert.equal(f.id('memory-editor').open,false);assert.match(f.id('memory-message').textContent,/changed/);});
test('deletion preview and cancel never remove a memory',async()=>{let removes=0;const f=await setup((path)=>{if(path==='/api/memory/delete/preview')return response({ok:true,confirmation:'a'.repeat(64),expiresAt:Date.now()+120000,summary:'Delete this memory?',residuals:['Backups remain.']});if(path==='/api/memory/delete'){removes++;return response({ok:true,receipt:{state:'complete',message:'Removed'}});}});f.button('Edit memory: '+item.text).click();await f.app.idle();f.button('Delete memory').click();await f.app.idle();assert.equal(f.id('memory-preview').open,true);f.button('Cancel').click();assert.equal(removes,0);});
test('expired deletion reviews cannot send a destructive request',async()=>{let removes=0;const f=await setup(path=>{if(path==='/api/memory/delete/preview')return response({ok:true,confirmation:'b'.repeat(64),expiresAt:Date.now()-1,summary:'Expired',residuals:[]});if(path==='/api/memory/delete'){removes++;}});f.button('Edit memory: '+item.text).click();await f.app.idle();f.button('Delete memory').click();await f.app.idle();f.button('Confirm delete').click();await f.app.idle();assert.equal(removes,0);assert.match(f.id('memory-message').textContent,/expired/);});
test('an uncertain deletion never reuses the same confirmation capability',async()=>{let removes=0;const f=await setup(path=>{if(path==='/api/memory/delete/preview')return response({ok:true,confirmation:'c'.repeat(64),expiresAt:Date.now()+120000,summary:'Review',residuals:[]});if(path==='/api/memory/delete'){removes++;throw Error('Cannot reach Nemo.');}});f.button('Edit memory: '+item.text).click();await f.app.idle();f.button('Delete memory').click();await f.app.idle();f.button('Confirm delete').click();await f.app.idle();f.button('Confirm delete').click();await f.app.idle();assert.equal(removes,1);assert.equal(f.app.state.confirmation,null);});
test('a partial deletion remains an explicit partial result',async()=>{const f=await setup(path=>{if(path==='/api/memory/delete/preview')return response({ok:true,confirmation:'d'.repeat(64),expiresAt:Date.now()+120000,summary:'Review',residuals:[]});if(path==='/api/memory/delete')return response({ok:true,receipt:{state:'incomplete',message:'The stored copy remains.'}});});f.button('Edit memory: '+item.text).click();await f.app.idle();f.button('Delete memory').click();await f.app.idle();f.button('Confirm delete').click();await f.app.idle();assert.match(f.id('memory-message').textContent,/Some memories remain/);});
test('disconnected memory disables adding and exposes explicit local setup',async()=>{const f=await setup(path=>path==='/api/memory/board'?response(board([],false)):null);assert.equal(f.id('memory-add').disabled,true);assert.equal(f.id('memory-enable').hidden,false);assert.match(f.id('memory-summary').textContent,/worth remembering/);});
test('automatic learning control changes only the learning setting',async()=>{let change;const f=await setup((path,options)=>{if(path==='/api/memory/learning'){change=JSON.parse(options.body);return response({ok:true});}});f.id('memory-learning').checked=false;f.id('memory-learning').fire('change');await f.app.idle();assert.deepEqual(change,{enabled:false});assert.equal(f.calls.some(call=>call.path.includes('gmail/cache')),false);});
test('untrusted memory text is rendered as text and source evidence remains inspectable',async()=>{const unsafe={...item,text:'<script>untrusted</script>'};const f=await setup(path=>path==='/api/memory/board'?response(board([unsafe])):null);assert.match(f.id('memory-list').textContent,/<script>untrusted<\/script>/);assert.equal(all(f.doc.body).some(node=>node.tagName==='SCRIPT'),false);f.app.chooseSummary([{id:item.id,revision:'r1',text:item.text}]);await f.app.idle();assert.match(f.id('memory-editor').textContent,/I prefer concise answers/);});

const nativeItem={...item,id:'hermes:user:'+'a'.repeat(64),target:'user',sourceLabel:'Hermes memory'};
const nativeBoard=(items=[nativeItem])=>({...board(items),kind:'hermes-builtin',automatic:true,learning:{enabled:true,processing:'hermes'}});
async function nativeSetup(handler){
 const f=memoryDom(),calls=[];
 const fetch=async(path,options)=>{
  calls.push({path,options});const custom=await handler?.(path,options);if(custom)return custom;
  if(path==='/api/memory/board')return response(nativeBoard());
  if(path.startsWith('/api/memory/fact'))return response({ok:true,item:{...nativeItem,text:nativeItem.text}});
  throw Error('Unexpected native Memory route: '+path);
 };
 fetch.memoryMode='profile-hermes';const app=createMemoryApp(f.doc,fetch);await app.ready;return{...f,app,calls};
}

test('native Memory is automatic with no engine, Off, source-copy or semantic-search controls',async()=>{
 const f=await nativeSetup();assert.equal(f.id('memory-automatic').textContent,'Memory is automatic. Nemo keeps useful details as you chat.');assert.equal(f.id('memory-automatic').hidden,false);assert.match(f.id('memory-list').textContent,/Saved detail/);
 assert.equal(f.id('memory-learning'),null);assert.equal(f.id('memory-enable'),null);assert.equal(f.id('memory-gmail-source'),null);
 assert.doesNotMatch(f.doc.body.textContent,/Hermes|GBrain|Ollama|turn learning off|Enable local memory/);
 f.id('memory-search').value='concise';f.id('memory-search-form').fire('submit');await f.app.idle();
 assert.equal(f.calls.length,1);assert.match(f.id('memory-list').textContent,/concise answers/);
 f.button('Memory settings').click();assert.match(f.id('memory-settings').textContent,/sent with ChatGPT requests/);
 assert.match(f.id('memory-settings').textContent,/Clearing does not stop future learning/);
});

test('a native initial read failure offers retry without exposing legacy setup or Off controls',async()=>{
 let fail=true;const f=await nativeSetup(path=>path==='/api/memory/board'&&fail?response({error:'Stored notes could not be read.'},503):null);
 assert.equal(f.id('memory-summary').textContent,'Your memories could not be read.');assert.equal(f.id('memory-retry').hidden,false);
 assert.equal(f.id('memory-learning'),null);assert.equal(f.id('memory-enable'),null);assert.equal(f.button('Memory settings').disabled,true);
 assert.equal(f.id('memory-add').disabled,true);fail=false;f.button('Try again').click();await f.app.idle();
 assert.equal(f.id('memory-retry').hidden,true);assert.equal(f.id('memory-message').hidden,true);assert.match(f.id('memory-list').textContent,/concise/);
});

test('native summary editing uses the saved note and revision without a separate correction engine',async()=>{
 let saved;const f=await nativeSetup((path,options)=>{if(path==='/api/memory/edit'){saved=JSON.parse(options.body);return response({ok:true});}});
 f.app.chooseSummary([{id:nativeItem.id,revision:nativeItem.revision,text:nativeItem.text}]);await f.app.idle();
 assert.equal(f.id('memory-editor-text').value,nativeItem.text);assert.equal(f.id('memory-editor-text').maxLength,1375);assert.equal(f.id('memory-editor-topic').disabled,true);
 f.id('memory-editor-text').value='You prefer answers with examples.';f.button('Save memory').click();await f.app.idle();
 assert.deepEqual(saved,{id:nativeItem.id,revision:'r1',title:'You prefer answers with examples.',content:'You prefer answers with examples.',category:'preferences'});
 assert.equal(f.calls.some(call=>call.path==='/api/memory/correct'),false);
});

test('native Clear previews before deletion, cancellation is safe, and partial receipts survive refresh',async()=>{
 let previews=0,deletes=0;const f=await nativeSetup((path,options)=>{
  if(path==='/api/memory/clear/preview'){previews++;assert.deepEqual(JSON.parse(options.body),{scope:'notes'});return response({ok:true,confirmation:'e'.repeat(64),expiresAt:Date.now()+60000,summary:'Clear both memory stores?',residuals:['History remains.']});}
  if(path==='/api/memory/delete'){deletes++;return response({ok:false,receipt:{state:'partial',message:'One store could not be cleared.'}});}
 });
 f.button('Memory settings').click();f.button('Clear memories').click();await f.app.idle();assert.equal(previews,1);assert.equal(deletes,0);
 f.button('Cancel').click();assert.equal(deletes,0);f.id('memory-clear').click();await f.app.idle();f.id('memory-confirm-delete').click();f.id('memory-confirm-delete').click();await f.app.idle();
 assert.equal(deletes,1);assert.match(f.id('memory-message').textContent,/Some memories may remain.*could not be cleared/);assert.match(f.id('memory-list').textContent,/concise/);
 assert.equal(f.app.state.confirmation,null);
});

test('native Forget removes a note rather than offering a paused-memory state',async()=>{
 let payload;const f=await nativeSetup((path,options)=>{if(path==='/api/memory/delete/preview'){payload=JSON.parse(options.body);return response({ok:true,confirmation:'f'.repeat(64),expiresAt:Date.now()+60000,summary:'Forget this saved note?',residuals:[]});}});
 f.button('Edit memory: '+nativeItem.text).click();await f.app.idle();f.button('Forget memory').click();await f.app.idle();
 assert.deepEqual(payload,{id:nativeItem.id,action:'forget'});assert.equal(f.id('memory-confirm-delete').textContent,'Forget memory');
 assert.equal(f.button('Delete memory').hidden,true);
});

test('a native partial-clear receipt is retained when refreshing the remaining notes also fails',async()=>{
 let failed=false;const f=await nativeSetup(path=>{
  if(path==='/api/memory/clear/preview')return response({ok:true,confirmation:'0'.repeat(64),expiresAt:Date.now()+60000,summary:'Clear notes?',residuals:[]});
  if(path==='/api/memory/delete'){failed=true;return response({ok:false,receipt:{state:'partial',message:'The second store remains.'}});}
  if(path==='/api/memory/board'&&failed)return response({error:'Refresh could not read notes.'},503);
 });
 f.button('Memory settings').click();f.id('memory-clear').click();await f.app.idle();f.id('memory-confirm-delete').click();await f.app.idle();
 assert.match(f.id('memory-message').textContent,/Some memories may remain.*second store remains.*could not read/);assert.equal(f.id('memory-retry').hidden,false);
});

test('native partial receipts cannot turn an unrelated failed save into success',async()=>{
 const f=await nativeSetup(path=>path==='/api/memory/notes'?response({ok:false,receipt:{state:'partial',message:'This is not a save result.'}}):null);
 f.button('+ Add').click();await f.app.idle();f.id('memory-editor-text').value='A new note.';f.button('Save memory').click();await f.app.idle();
 assert.equal(f.id('memory-editor').open,true);assert.match(f.id('memory-message').textContent,/could not complete/);assert.doesNotMatch(f.id('memory-message').textContent,/Memory saved/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createMemoryMirror} from '../lib/memory-mirror.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(fileURLToPath(new URL('./.tmp-mirror-',import.meta.url)));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let mode='sync';let account='synthetic-A';let messages=[{id:'m1',from:'sender.invalid',subject:'Rail ticket',date:'2026-10-21',snippet:'Window seat'}];
  let events=[{id:'e1',title:'Lesson',start:'2026-10-21T09:00:00+11:00',end:'2026-10-21T10:00:00+11:00'}];
  let connected=true;let fail=false;
  const stored={gmail:[],calendar:[]};const calls=[];
  const gbrain={async mirrorCopies(source,records,excluded){calls.push({source,records:structuredClone(records),excluded:[...excluded]});if(fail)throw Error('private upstream text');stored[source]=structuredClone(records);return {ok:true,source,desiredCount:records.length,updated:records.length,removed:0};}};
  const options={dataDir,gbrain,gmail:{cachedMessages:async()=>({mode,messages}),status:async()=>({account})},calendar:{read:()=>({connected,events})},now:()=>Date.parse('2026-10-21T00:00:00Z')};
  const mirror=await createMemoryMirror(options);
  return {mirror,dataDir,options,calls,stored,set(value){if(value.mode)mode=value.mode;if(value.messages)messages=value.messages;if(value.events)events=value.events;if(value.account)account=value.account;if(value.connected!==undefined)connected=value.connected;if(value.fail!==undefined)fail=value.fail;}};
}
test('sources start off and only explicit opt-in copies bounded permitted fields',async t=>{
  const f=await fixture(t);await f.mirror.syncAll();assert.deepEqual(f.stored,{gmail:[],calendar:[]});
  await f.mirror.configure({gmail:true,calendar:true});await f.mirror.syncAll();
  assert.equal(f.stored.gmail.length,1);assert.equal(f.stored.calendar.length,1);
  assert.equal(f.mirror.status().localProcessing,true);assert.equal(f.mirror.status().retention,'mirror');
  const disk=await readFile(`${f.dataDir}/memory-mirror.json`,'utf8');
  for(const text of ['Rail ticket','Window seat','sender.invalid','Lesson','synthetic-A'])assert.equal(disk.includes(text),false);
});
test('unchanged snapshots skip database work; current snapshot replacement prunes history',async t=>{
  const f=await fixture(t);await f.mirror.configure({gmail:true,calendar:true});await f.mirror.syncAll();const n=f.calls.length;
  await f.mirror.syncAll();assert.equal(f.calls.length,n);
  f.set({messages:[{id:'m2',subject:'New copy',snippet:'Only current'}],events:[]});await f.mirror.syncAll();
  assert.equal(f.stored.gmail.length,1);assert.ok(f.stored.gmail[0].id.endsWith('m2'));assert.equal(f.stored.calendar.length,0);
});
test('clearing cache, switching account and disconnecting calendar remove old source copies',async t=>{
  const f=await fixture(t);await f.mirror.configure({gmail:true,calendar:true});await f.mirror.syncAll();
  const old=f.stored.gmail[0].id;f.set({account:'synthetic-B'});await f.mirror.sync('gmail');assert.notEqual(f.stored.gmail[0].id,old);
  f.set({mode:'demand',connected:false});await f.mirror.syncAll();assert.equal(f.stored.gmail.length,0);assert.equal(f.stored.calendar.length,0);
});
test('individual deletions persist an opaque exclusion and cannot silently reimport',async t=>{
  const f=await fixture(t);await f.mirror.configure({gmail:true,calendar:true});await f.mirror.syncAll();
  const id=f.stored.gmail[0].id;const slug=`nemo-notes/gmail/${createHash('sha256').update(id).digest('hex').slice(0,32)}`;
  await f.mirror.exclude(slug);await f.mirror.sync('gmail');assert.equal(f.stored.gmail.length,0);
  const reloaded=await createMemoryMirror(f.options);await reloaded.sync('gmail');assert.equal(f.stored.gmail.length,0);
  await reloaded.calendarRemoved(['e1']);assert.equal(f.stored.calendar.length,0);
});
test('failed source deletion cannot claim disabled or successful clearing',async t=>{
  const f=await fixture(t);await f.mirror.configure({gmail:true,calendar:false});await f.mirror.sync('gmail');f.set({fail:true});
  await assert.rejects(f.mirror.configure({gmail:false,calendar:false}),/could not be synchronized/);
  assert.equal(f.mirror.status().sources.gmail,true);assert.ok(f.mirror.status().error);
  f.set({fail:false});await f.mirror.configure({gmail:false,calendar:false});assert.equal(f.stored.gmail.length,0);assert.equal(f.mirror.status().sources.gmail,false);
});
test('missing engine cannot silently accept enabled source mirroring',async t=>{
  const f=await fixture(t);const mirror=await createMemoryMirror({...f.options,gbrain:{}});
  await mirror.syncAll();await mirror.configure({gmail:true,calendar:true});await assert.rejects(mirror.syncAll());
});

test('calendar exclusion purges old memory copies, prevents re-enabling and leaves the snapshot alone',async t=>{
  const f=await fixture(t);await f.mirror.configure({gmail:true,calendar:true});await f.mirror.syncAll();
  assert.equal(f.stored.calendar.length,1);const before=f.options.calendar.read();
  const current=await createMemoryMirror({...f.options,includeCalendar:false});await current.excludeCalendar();
  assert.equal(current.status().sources.calendar,false);assert.equal(f.stored.calendar.length,0);assert.equal(f.stored.gmail.length,1);
  await assert.rejects(current.configure({gmail:true,calendar:true}));await current.syncAll();
  assert.deepEqual(f.options.calendar.read(),before);assert.equal(f.stored.calendar.length,0);
  f.set({fail:true});assert.equal((await current.clear('calendar')).excluded,true,'Calendar is independent of a later Memory engine failure.');
});

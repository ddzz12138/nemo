import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createProfileStore} from '../lib/profile-store.mjs';
import {createCalendarStore} from '../lib/calendar.mjs';
import {createMcpHandler} from '../mcp-server.mjs';
import {createHermesEventPolicy} from '../lib/hermes.mjs';
import {connectionToolNames,policyRevision} from '../lib/family-policy.mjs';

test('Hermes proof binds the exact child tool subset rather than every family tool',()=>{
  const policy=createHermesEventPolicy(true,{family:true,memoryEnabled:true,allowedConnectionTools:['calendar_list']});
  assert.throws(()=>policy.observe({type:'nemo_guard',stage:'startup',version:4,isolated:true,tools:['mcp__nemo__calendar_list','mcp__nemo__gmail_search']}));
  policy.observe({type:'nemo_guard',stage:'startup',version:4,isolated:true,tools:['mcp__nemo__calendar_list']});
  assert.equal(policy.verified,true);
  assert.throws(()=>policy.observe({type:'tool_use',name:'mcp__nemo__gmail_search',input:{query:'forged'}}));
  assert.throws(()=>createHermesEventPolicy(true,{family:true,allowedConnectionTools:['terminal']}));
});

test('a revoked tool cannot return a late result even if its source read was already underway',async()=>{
  let allowed=true,release;const blocked=new Promise(resolve=>release=resolve);
  const handle=createMcpHandler({calendar:{async read(){await blocked;return{events:[{title:'LATE_PRIVATE_RESULT'}]}}}},{family:true,allowedTools:['calendar_list'],authorizeTool:async()=>allowed});
  await handle({jsonrpc:'2.0',id:1,method:'initialize'});await handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const pending=handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'calendar_list',arguments:{}}});
  await new Promise(resolve=>setImmediate(resolve));allowed=false;release();
  const result=await pending;assert.equal(result.result.isError,true);assert.ok(!JSON.stringify(result).includes('LATE_PRIVATE_RESULT'));
});

test('a live family MCP process rechecks child permission and policy before every call',async t=>{
  const prefix=fileURLToPath(new URL('./.tmp-family-policy-',import.meta.url)),root=await mkdtemp(prefix);
  const registry=await createProfileStore({dataDir:root}),profile=await registry.create('Synthetic learner',true);
  await registry.setCapability(profile.id,'calendar',true);const current=await registry.profile(profile.id);
  assert.deepEqual(connectionToolNames(current),['calendar_list']);
  const calendar=await createCalendarStore({dataDir:join(root,'profiles',profile.id)}),token=await calendar.issueToken(),now=Date.now();
  await calendar.importSnapshot({events:[{title:'SYNTHETIC_CHILD_EVENT',start:new Date(now+3600000).toISOString(),end:new Date(now+7200000).toISOString()}]},token);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('NEMO_MCP_')));
  Object.assign(env,{NEMO_MCP_DATA_DIR:join(root,'profiles',profile.id),NEMO_MCP_CONFIG_DIR:root,NEMO_MCP_PROFILE_ID:profile.id,NEMO_MCP_ALLOWED_TOOLS:JSON.stringify(['calendar_list']),NEMO_MCP_PERMISSION_REVISION:policyRevision(current)});
  const child=spawn(process.execPath,['mcp-server.mjs'],{cwd:resolve('.'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const closed=once(child,'close'),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  t.after(async()=>{child.stdin.end();child.kill();await closed;assert.equal(dirname(resolve(root)),dirname(resolve(prefix)));assert.ok(root.startsWith(prefix));await rm(root,{recursive:true,force:true});});
  async function send(message){child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');if(!message.id)return;const line=await lines.next();assert.equal(line.done,false);return JSON.parse(line.value);}
  await send({id:1,method:'initialize'});await send({method:'notifications/initialized'});
  assert.deepEqual((await send({id:2,method:'tools/list'})).result.tools.map(tool=>tool.name),['calendar_list']);
  assert.equal((await send({id:3,method:'tools/call',params:{name:'gmail_search',arguments:{query:'forged'}}})).error.code,-32602);
  assert.match(JSON.stringify(await send({id:4,method:'tools/call',params:{name:'calendar_list',arguments:{}}})),/SYNTHETIC_CHILD_EVENT/);
  await registry.setCapability(profile.id,'calendar',false);
  const revoked=await send({id:5,method:'tools/call',params:{name:'calendar_list',arguments:{}}});assert.equal(revoked.result.isError,true);assert.ok(!JSON.stringify(revoked).includes('SYNTHETIC_CHILD_EVENT'));
  await registry.setCapability(profile.id,'calendar',true);
  assert.equal((await send({id:6,method:'tools/call',params:{name:'calendar_list',arguments:{}}})).result.isError,true,'a fresh grant cannot revive an old task');
});

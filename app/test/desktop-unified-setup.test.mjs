import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupClient, setupState, setupMessage } from '../public/desktop-setup.mjs';
import { takeDesktopRoute } from '../public/desktop-route.mjs';

test('unified setup does not open chat before name, runtime and an active provider are ready', () => {
  const status={owner:{name:'Owner',configured:false},runtime:{ready:false},app:{ready:true}};
  assert.equal(setupState(null),'loading');assert.equal(setupState(status),'name');
  status.owner={name:'Dan',configured:true};assert.equal(setupState(status),'runtime');
  status.runtime={ready:true,connected:false,assistant:{provider:'chatgpt',connected:false,phase:'waiting'}};assert.equal(setupState(status),'assistant');
  status.runtime.connected=true;Object.assign(status.runtime.assistant,{connected:true,phase:'connected',planUsageEnabled:true});assert.equal(setupState(status),'ready');
  status.runtime.assistant.phase='error';assert.equal(setupState(status),'assistant');
  status.runtime.assistant.phase='connected';status.app.ready=false;assert.equal(setupState(status),'assistant');
});

test('local CLI setup clears its capability fragment before making a bounded named request',async()=>{
  const events=[],location={hash:'#setup=PRIVATE_LAUNCH_CAPABILITY',pathname:'/setup/'};
  const client=createSetupClient({location,history:{replaceState(){events.push('clear');location.hash='';}},fetchImpl:async(path,options)=>{events.push(path);assert.equal(options.headers.Authorization,'Bearer PRIVATE_LAUNCH_CAPABILITY');assert.equal(options.redirect,'error');return Response.json({owner:{name:'Dan'}});}});
  const result=await client.request('owner',{name:'Dan'});assert.equal(result.owner.name,'Dan');assert.deepEqual(events,['clear','/api/setup/owner']);
  await assert.rejects(client.request('https://evil.test'),/Open Nemo/);client.dispose();await assert.rejects(client.request('status'),/Open Nemo/);
});

test('desktop setup bridge pins the displayed profile and never hands a capability to the renderer',async()=>{
  let id='first';const calls=[];
  const client=createSetupClient({desktop:{async request(...args){calls.push(args);return{};}},getProfileId:()=>id,location:{hash:'',pathname:'/desktop.html'},history:{}});
  await client.request('status');id='second';await client.request('assistant',{action:'signout'});
  assert.deepEqual(calls,[['status',{},'first'],['assistant',{action:'signout'},'second']]);
  assert.match(setupMessage(new Error('ENOENT C:\\private\\thing')),/Reopen the app/);
});

test('native menu and new invitations work as same-document routes without retaining codes',()=>{
  const location={pathname:'/desktop.html',hash:'#settings'},history={replaceState(){location.hash='';}};
  assert.deepEqual(takeDesktopRoute(location,history),{page:'settings',invitation:null});assert.equal(location.hash,'');
  location.hash='#invite=ABCD-EFGH-JKLM-NPQR';assert.deepEqual(takeDesktopRoute(location,history),{page:'chat',invitation:'ABCD-EFGH-JKLM-NPQR'});assert.equal(location.hash,'');
  location.hash='#invite=a&invite=b';assert.equal(takeDesktopRoute(location,history).invitation,'');
});

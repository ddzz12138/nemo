import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {once} from 'node:events';
import {createFamilyServer} from '../lib/family-server.mjs';

test('full Hermes is local-owner only, rejects arbitrary controls, blocks concurrent normal chat and stops at logout',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-workspace-http-'));
  let busy=false,closed=false,starts=0,authorizes;
  const app=await createFamilyServer({dataDir,publicDir:resolve('public'),logger(){},provider:{status:()=>({connected:true})},workspaceFactory:async options=>{
    authorizes=options.isAuthorized;assert.equal(await authorizes(),true,'initial status must bind its authenticated device before constructing the service');
    return {isBusy:()=>busy,status:async()=>({phase:busy?'ready':'idle',busy}),start:async()=>{assert.equal(await authorizes(),true);starts++;busy=true;return {busy};},prompt:async()=>({accepted:true}),respond:async()=>({accepted:true}),stop:async()=>{busy=false;return {busy};},invalidate:async()=>{busy=false;},close:async()=>{closed=true;busy=false;}};
  }});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();assert.equal(closed,true);assert.equal(dirname(dataDir),tmpdir());assert.ok(basename(dataDir).startsWith('nemo-workspace-http-'));await rm(dataDir,{recursive:true});});
  const base='http://127.0.0.1:'+app.server.address().port;
  async function pair(profile){const invite=await app.profiles.invite(profile.id),response=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},body:JSON.stringify({code:invite.code,expectedProfileId:profile.id})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  const owner=await app.profiles.owner(),ownerCookie=await pair(owner),child=await app.profiles.create('Synthetic child',true),childCookie=await pair(child),adult=await app.profiles.create('Synthetic adult',false),adultCookie=await pair(adult);
  const request=(profile,cookie,action,input,headers={})=>fetch(base+'/api/hermes-workspace/'+action,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,'X-Nemo-Profile':profile.id,...(input===undefined?{}:{'Content-Type':'application/json','X-Nemo-Request':'1'}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
  assert.equal((await request(child,childCookie,'start',{})).status,403);
  assert.equal((await request(adult,adultCookie,'start',{})).status,403);
  assert.equal((await request(owner,ownerCookie,'status',undefined,{'X-Forwarded-For':'203.0.113.1'})).status,403);
  assert.equal((await request(owner,ownerCookie,'start',{toolsets:['all']})).status,400);
  assert.equal((await request(owner,ownerCookie,'status')).status,200);
  assert.equal(starts,0);
  assert.equal((await request(owner,ownerCookie,'start',{})).status,200);assert.equal(busy,true);
  const secondOwnerCookie=await pair(owner);
  assert.equal((await request(owner,secondOwnerCookie,'status')).status,200);
  assert.equal((await request(owner,secondOwnerCookie,'start',{})).status,403,'another device cannot take over an active workspace');
  assert.equal((await request(owner,secondOwnerCookie,'respond',{id:'old-request',result:{choice:'once'}})).status,403);
  assert.equal(starts,1);assert.equal(await authorizes(),true);
  const normal=await fetch(base+'/api/chat',{method:'POST',headers:{Cookie:ownerCookie,'X-Nemo-Profile':owner.id,'X-Nemo-Request':'1','Content-Type':'application/json'},body:JSON.stringify({message:'Synthetic',requestId:crypto.randomUUID()})});
  assert.equal(normal.status,409);
  const logout=await fetch(base+'/api/logout',{method:'POST',headers:{Cookie:ownerCookie,'X-Nemo-Profile':owner.id,'X-Nemo-Request':'1','Content-Type':'application/json'},body:'{}'});
  assert.equal(logout.status,200);assert.equal(busy,false);assert.equal(await authorizes(),false);
  assert.equal((await request(owner,ownerCookie,'start',{})).status,401);
});

test('family host retries the same unresolved workspace cleanup without reopening its routes',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-workspace-http-'));let failed=true,closes=0;
  const app=await createFamilyServer({dataDir,publicDir:resolve('public'),logger(){},provider:{status:()=>({connected:true})},workspaceFactory:async()=>({isBusy:()=>failed,status:async()=>({busy:failed}),async close(){closes++;if(failed)throw new Error('Synthetic native stop unconfirmed');}})});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{failed=false;await app.close();assert.equal(dirname(dataDir),tmpdir());assert.ok(basename(dataDir).startsWith('nemo-workspace-http-'));await rm(dataDir,{recursive:true});});
  const base='http://127.0.0.1:'+app.server.address().port,owner=await app.profiles.owner(),invite=await app.profiles.invite(owner.id);
  const paired=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},body:JSON.stringify({code:invite.code,expectedProfileId:owner.id})});
  const cookie=paired.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/hermes-workspace/status',{headers:{Cookie:cookie,'X-Nemo-Profile':owner.id}})).status,200);
  await assert.rejects(app.close());assert.equal(closes,1);assert.equal(app.server.listening,false);
  failed=false;await app.close();assert.equal(closes,2);assert.equal(app.server.listening,false);
});

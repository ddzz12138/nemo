import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../public/memory-auth.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const A={id:'11111111-1111-4111-8111-111111111111',name:'Ari'};
const B={id:'22222222-2222-4222-8222-222222222222',name:'Bea'};
function fixture(fetchImpl,identity=A){
 const window={NemoIdentity:{profile:identity}};
 const context=vm.createContext({window});
 vm.runInContext(source+'\nglobalThis.bindMemory=getProfileMemoryFetch;',context);
 return {window,bind:()=>context.bindMemory(fetchImpl)};
}
test('Memory pins every read and write to the initially authenticated profile',async()=>{
 const calls=[];
 const f=fixture(async(path,options)=>{calls.push({path,options});return Response.json(path==='/api/session'?{authenticated:true,profile:A}:{ok:true});});
 const bound=await f.bind();
 await bound('/api/memory');
 await bound('/api/memory/semantic',{method:'POST',headers:{'X-Nemo-Request':'1','X-Nemo-Profile':B.id},body:'{}'});
 assert.equal(bound.profile.id,A.id);
 assert.equal(calls.filter(call=>call.path==='/api/session').length,1);
 for(const call of calls.slice(1))assert.equal(call.options.headers['X-Nemo-Profile'],A.id);
 assert.equal(calls[2].options.headers['X-Nemo-Request'],'1');
});
test('Memory refuses an unauthenticated, absent or invalid profile without making a data request',async()=>{
 for(const data of [{authenticated:false,profile:A},{authenticated:true},{authenticated:true,profile:{id:'../owner'}}]){
  let calls=0;const f=fixture(async()=>{calls++;return Response.json(data);});
  await assert.rejects(f.bind(),/Sign in/);assert.equal(calls,1);
 }
});
test('Memory blocks stale requests before sending and discards an in-flight previous-profile result',async()=>{
 let release;const calls=[];
 const f=fixture(async(path)=>{calls.push(path);if(path==='/api/session')return Response.json({authenticated:true,profile:A});return new Promise(resolve=>{release=()=>resolve(Response.json({private:'synthetic A only'}));});});
 const bound=await f.bind();const pending=bound('/api/memory');
 await new Promise(done=>setImmediate(done));
 f.window.NemoIdentity.profile=B;release();
 await assert.rejects(pending,/profile changed/);
 const before=calls.length;await assert.rejects(bound('/api/memory',{method:'POST'}),/profile changed/);assert.equal(calls.length,before);
});
test('Memory treats a server PROFILE_CHANGED response as a reload requirement',async()=>{
 const f=fixture(async path=>Response.json(path==='/api/session'?{authenticated:true,profile:A}:{code:'PROFILE_CHANGED'},{status:path==='/api/session'?200:409}));
 const bound=await f.bind();await assert.rejects(bound('/api/memory'),/Reload Memory/);
});

test('Memory reuses the navigation identity loader while preserving profile pinning',async()=>{
 let loads=0,requests=0;const f=fixture(async()=>{requests++;return Response.json({ok:true});});
 const fetchImpl=async()=>{requests++;return Response.json({ok:true});};
 f.window.nemoFetch=fetchImpl;f.window.NemoIdentity.load=async()=>{loads++;return{authenticated:true,profile:A};};
 const context=vm.createContext({window:f.window});vm.runInContext(source+'\nglobalThis.bindMemory=getProfileMemoryFetch;',context);
 const bound=await context.bindMemory(fetchImpl);assert.equal(loads,1);assert.equal(requests,0);
 await bound('/api/memory/board');assert.equal(requests,1);f.window.NemoIdentity.profile=B;
 await assert.rejects(bound('/api/memory/board'),/profile changed/);assert.equal(requests,1);
});

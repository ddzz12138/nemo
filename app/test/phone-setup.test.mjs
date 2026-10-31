import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,webcrypto} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {phoneAppOrigin,phoneInvitationPath} from '../public/phone-link-setup.js';
import {createPhoneClient} from '../public/phone-link-client.js';
import {requestIceGrant} from '../public/phone-link-mailbox.js';
import {createPhoneLink} from '../lib/phone-link.mjs';
import {setupPhoneStart} from '../public/phone-start.js';

test('phone setup uses a stable production address rather than an immutable deployment',()=>{
  assert.equal(phoneAppOrigin('https://36541d47.nemo-phone.pages.dev/phone-start'),'https://nemo-phone.pages.dev');
  assert.equal(phoneAppOrigin('https://nemo-phone.pages.dev/phone-start.html'),'https://nemo-phone.pages.dev');
  assert.equal(phoneAppOrigin('https://phone.example.test'),'https://phone.example.test');
  assert.equal(phoneAppOrigin('http://localhost:8787'),'http://localhost:8787');
  for(const value of ['http://phone.example.test','https://user:pass@phone.example.test','https://phone.example.test?token=secret','https://phone.example.test/pair.html#phone=secret','https://phone.example.test/anything',null])assert.throws(()=>phoneAppOrigin(value));
});

test('canonical invitation paths survive Pages redirects but cannot switch projects',()=>{
  for(const path of ['/pair','/pair.html'])assert.equal(phoneInvitationPath('https://36541d47.nemo-phone.pages.dev'+path+'#phone=synthetic','https://nemo-phone.pages.dev'),'/pair.html#phone=synthetic');
  for(const value of ['https://other.pages.dev/pair#phone=synthetic','https://nemo-phone.pages.dev/phone-start#phone=synthetic','https://nemo-phone.pages.dev/pair?redirect=other#phone=synthetic','https://nemo-phone.pages.dev/pair#invite=old-cookie-code'])assert.throws(()=>phoneInvitationPath(value,'https://nemo-phone.pages.dev'));
});

function startScreen(connection){
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,textContent:'',handlers:{},addEventListener(type,handler){this.handlers[type]=handler;}});return nodes.get(id);};
  let destination,forgot=0;
  setupPhoneStart({document:{getElementById:node},location:{origin:'https://nemo-phone.pages.dev',search:'',assign:value=>{destination=value;},reload:()=>{forgot++;}},connection,confirm:()=>true});
  return{node,get destination(){return destination;},get reloads(){return forgot;}};
}

test('pasting a valid invitation never signs out or forgets the current person',async()=>{
  let forgotten=0;const connection={ready:Promise.resolve(),enabled:true,forget:async()=>{forgotten++;}};
  const screen=startScreen(connection);await tick();
  screen.node('phoneInvitation').value='https://36541d47.nemo-phone.pages.dev/pair#phone=synthetic';
  screen.node('phoneInvitationForm').handlers.submit({preventDefault(){}});
  assert.equal(screen.destination,'/pair.html#phone=synthetic');assert.equal(forgotten,0);assert.equal(screen.reloads,0);
  assert.equal(screen.node('resumePhone').hidden,false);
});

test('phone setup shows storage failure and leaves an invalid invitation on the current page',async()=>{
  const screen=startScreen({ready:Promise.reject(new Error('Phone storage is unavailable. Open Safari outside private browsing.')),enabled:false});await tick();
  assert.match(screen.node('phoneStartStatus').textContent,/storage is unavailable/);
  screen.node('phoneInvitation').value='https://other.pages.dev/pair#phone=synthetic';
  screen.node('phoneInvitationForm').handlers.submit({preventDefault(){}});
  assert.equal(screen.destination,undefined);assert.match(screen.node('phoneStartStatus').textContent,/complete personal invitation/);
});

async function connectionFixture(t,grantProvider){
  const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=await webcrypto.subtle.exportKey('jwk',pair.publicKey);
  const descriptor={v:1,id:randomUUID(),room:'a'.repeat(64),password:'b'.repeat(64),hostKey:publicKey,relays:['wss://discovery.example.test']};
  const rooms=[],states=[];
  class PeerConnection{}
  const nostr={selfId:'synthetic-phone-123',joinRoom(){const room={makeAction:()=>({request:async()=>{},send:async()=>{}}),getPeers:()=>({}),leave(){room.closed=true;}};rooms.push(room);return room;}};
  const client=createPhoneClient({descriptor,keys:{privateKey:pair.privateKey,publicKey},crypto:webcrypto,PeerConnection,nostr,grantProvider,onState:value=>states.push(value.state)});
  t.after(()=>client.close());return{client,rooms,states,descriptor,keys:{privateKey:pair.privateKey,publicKey},nostr};
}

test('suspending during discovery immediately frees the connection for a new attempt',{timeout:2000},async t=>{
  let resolveGrant,firstSignal,calls=0;
  const f=await connectionFixture(t,({signal})=>++calls===1?new Promise(resolve=>{resolveGrant=resolve;firstSignal=signal;}):Promise.resolve({iceServers:[]}));
  const first=assert.rejects(f.client.connect(),error=>error.code==='LINK_CLOSED');
  await tick();f.client.suspend();await first;assert.equal(firstSignal.aborted,true);
  const second=assert.rejects(f.client.connect(),error=>error.code==='LINK_CLOSED');await tick();assert.equal(f.rooms.length,1);
  resolveGrant({iceServers:[]});await tick();assert.equal(f.rooms.length,1,'late grant must not create an old room');
  f.client.close();await second;
});

test('suspending during ICE rejects the old wait and ignores old-room callbacks',{timeout:2000},async t=>{
  const f=await connectionFixture(t,async()=>({iceServers:[]}));
  const first=assert.rejects(f.client.connect(),error=>error.code==='LINK_CLOSED');await tick();assert.equal(f.rooms.length,1);
  f.client.suspend();await first;assert.equal(f.rooms[0].closed,true);
  const second=assert.rejects(f.client.connect(),error=>error.code==='LINK_CLOSED');await tick();assert.equal(f.rooms.length,2);
  const before=f.states.length;f.rooms[0].onPeerLeave?.('synthetic-host-123');assert.equal(f.states.length,before);
  f.client.close();await second;assert.equal(f.rooms[1].closed,true);
});

test('a synchronous transport startup failure cleans up the pending connection',{timeout:2000},async t=>{
  const f=await connectionFixture(t,async()=>({iceServers:[]}));f.nostr.joinRoom=()=>{throw new Error('Synthetic transport startup failure');};
  await assert.rejects(f.client.connect(),/Synthetic transport startup failure/);assert.equal(f.states.at(-1),'unavailable');
});

test('aborting relay discovery closes only its synthetic sockets and cancels its retry',{timeout:2000},async t=>{
  const f=await connectionFixture(t,async()=>({iceServers:[]}));const sockets=[];
  const socketFactory=()=>{const socket={readyState:0,addEventListener(){},send(){},close(){socket.closed=true;}};sockets.push(socket);return socket;};
  const controller=new AbortController();
  const result=assert.rejects(requestIceGrant({crypto:webcrypto,descriptor:f.descriptor,keys:f.keys,nostr:f.nostr,socketFactory,signal:controller.signal}),{name:'AbortError'});
  try{for(let n=0;n<150&&!sockets.length;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(sockets.length);}
  finally{controller.abort();await result;}
  assert.ok(sockets.every(socket=>socket.closed));
});

async function offlineHost(t,{enabled=false,origin='https://phone.example.test',verify=async()=>true,seed=null}={}){
  const fixtureRoot=resolve('.work/new-phone-fix');await mkdir(fixtureRoot,{recursive:true});
  const dataDir=await mkdtemp(join(fixtureRoot,'synthetic-setup-'));t.after(()=>{assert.equal(dirname(dataDir),fixtureRoot);return rm(dataDir,{recursive:true,force:true});});
  await writeFile(join(dataDir,'phone-link.json'),JSON.stringify({version:1,enabled,appOrigin:origin,relays:['wss://discovery.example.test']}));
  let saved=seed?structuredClone(seed):null;let opens=0,saves=0;
  const link=await createPhoneLink({dataDir,profiles:{deviceActive:async()=>false},dispatch:async()=>{},verifyFrontend:verify,secretStore:{load:async()=>saved,save:async value=>{saves++;saved=structuredClone(value);}},runtimeFactory:async()=>({selfId:'synthetic-host-123',joinRoom(){opens++;throw new Error('No room should be opened without an invitation');}}),mailboxFactory:async()=>({close:async()=>{},refresh:async()=>{}})});
  t.after(()=>link.close());return{link,dataDir,get saved(){return saved;},get opens(){return opens;},get saves(){return saves;}};
}

test('startup preserves the selected preview and explicit address updates preserve host identity',async t=>{
  const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const seed={version:1,hostPrivateKey:await webcrypto.subtle.exportKey('jwk',pair.privateKey),hostPublicKey:await webcrypto.subtle.exportKey('jwk',pair.publicKey),links:[{id:randomUUID(),profileId:randomUUID(),deviceId:randomUUID(),room:'c'.repeat(64),password:'d'.repeat(64)}],turn:null};
  const checked=[];const f=await offlineHost(t,{enabled:true,origin:'https://36541d47.nemo-phone.pages.dev',seed,verify:async origin=>{checked.push(origin);return true;}});
  assert.deepEqual(checked,[]);assert.equal(f.link.status().appOrigin,'https://36541d47.nemo-phone.pages.dev');
  assert.equal(f.link.status().suggestedAppOrigin,'https://nemo-phone.pages.dev');
  assert.equal(JSON.parse(await readFile(join(f.dataDir,'phone-link.json'),'utf8')).appOrigin,'https://36541d47.nemo-phone.pages.dev');
  assert.deepEqual(f.saved,seed);assert.equal(f.saves,0);
  const key=JSON.stringify(f.saved.hostPublicKey);
  await f.link.configure({appOrigin:'https://nemo-phone.pages.dev'});
  assert.deepEqual(checked,['https://nemo-phone.pages.dev']);assert.equal(f.link.status().appOrigin,'https://nemo-phone.pages.dev');
  await f.link.configure({appOrigin:'https://another-phone.example.test/phone-start'});
  assert.equal(f.link.status().enabled,true);assert.equal(JSON.stringify(f.saved.hostPublicKey),key);assert.equal(f.opens,0);assert.deepEqual(f.saved.links,seed.links);assert.equal(f.saves,0);
  assert.equal(JSON.parse(await readFile(join(f.dataDir,'phone-link.json'),'utf8')).appOrigin,'https://another-phone.example.test');
  await assert.rejects(f.link.configure({appOrigin:'https://phone.example.test',turn:null}),error=>error.code==='LINK_RUNNING');
});

test('a failed stable-address readiness check preserves the working preview setup',async t=>{
  const origin='https://36541d47.nemo-phone.pages.dev';const f=await offlineHost(t,{enabled:true,origin,verify:async()=>false});
  assert.equal(f.link.status().appOrigin,origin);await assert.rejects(f.link.configure({appOrigin:'https://nemo-phone.pages.dev'}),error=>error.code==='LINK_FRONTEND');
  assert.equal(f.link.status().appOrigin,origin);assert.equal(f.link.status().enabled,true);assert.equal(f.link.status().needsAddressUpdate,true);assert.equal(f.link.status().suggestedAppOrigin,'https://nemo-phone.pages.dev');
});

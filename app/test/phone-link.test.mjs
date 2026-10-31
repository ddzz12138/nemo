import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,randomUUID,webcrypto,createHmac } from 'node:crypto';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createPhoneLink,turnGrant,validateTurn,verifyPhoneFrontend } from '../lib/phone-link.mjs';
import { createHostMailbox } from '../lib/phone-link-mailbox.mjs';
import { transcript,signProof,verifyProof,validateRequest,decode64,publicKey,channelBinding } from '../public/phone-link-protocol.js';
import { mailboxTopic,sealMailbox,openMailbox,iceRequestText,iceReplyText } from '../public/phone-link-mailbox.js';

function fakeWire(){
  const rooms=new Map();let opens=0;
  return{rooms,get opens(){return opens;},selfId:'synthetic-host-123',joinRoom(config,id){opens++;const actions=new Map(),streams=new Map(),connection={localDescription:{sdp:'a=fingerprint:sha-256 '+Array(32).fill('BB').join(':')+'\r\n'},remoteDescription:{sdp:'a=fingerprint:sha-256 '+Array(32).fill('AA').join(':')+'\r\n'}};const room={config,actions,streams,connection,getPeers:()=>new Proxy({},{get:()=>connection}),makeAction(name,options={}){actions.set(name,options);return{async request(data){let stream=streams.get(data.id);if(!stream){stream={chunks:[],done:false};streams.set(data.id,stream);}if(data.data)stream.chunks.push(decode64(data.data));if(data.end||data.error){stream.done=true;stream.error=data.error;}return{ok:true};}};},leave(){room.closed=true;}};rooms.set(id,room);return room;}};
}
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-link-test-'));let state=null,time=Date.now(),calls=0;
  const wire=fakeWire(),secrets={async load(){return state?structuredClone(state):null;},async save(value){state=structuredClone(value);}};
  const app=await createFamilyServer({dataDir,publicDir:fileURLToPath(new URL('../public',import.meta.url)),now:()=>time,logger(){},
    provider:{status:()=>({connected:true}),async run(input){calls++;return{text:'Synthetic answer for '+input.profileId};}},
    phoneLinkFactory:createPhoneLink,phoneLinkOptions:{secretStore:secrets,runtimeFactory:async()=>wire,mailboxFactory:async()=>({refresh(){},close(){}}),verifyFrontend:async()=>true}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  return{app,wire,secrets,get saved(){return state;},get calls(){return calls;},now:()=>time,advance:ms=>{time+=ms;},base:'http://127.0.0.1:'+app.server.address().port};
}
async function invitation(f,profile){
  if(!f.app.phoneLink.status().enabled){await f.app.phoneLink.configure({appOrigin:'https://phone.example.test'});await f.app.phoneLink.enable();}
  const result=await f.app.phoneLink.invite(profile.id),descriptor=JSON.parse(Buffer.from(new URL(result.url).hash.slice(7),'base64url'));
  return{...result,descriptor,room:f.wire.rooms.get(descriptor.room)};
}
async function keys(){const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return{privateKey:pair.privateKey,publicKey:publicKey(await webcrypto.subtle.exportKey('jwk',pair.publicKey))};}
async function prove(f,invite,peer='synthetic-phone-123',key){
  key||=await keys();const nonce=randomBytes(32).toString('hex'),auth=invite.room.actions.get('nemo-auth').onRequest;
  const hello=await auth({kind:'hello',nonce,clientKey:key.publicKey},{peerId:peer});
  if(hello.error)return{error:hello.error};
  const text=transcript({id:invite.descriptor.id,clientPeer:peer,hostPeer:f.wire.selfId,nonce,challenge:hello.challenge,clientKey:key.publicKey,...channelBinding(invite.room.connection,true)});
  assert.equal(await verifyProof(webcrypto,invite.descriptor.hostKey,hello.signature,text),true);
  const signature=await signProof(webcrypto,key.privateKey,text),result=await auth({kind:'prove',signature},{peerId:peer});
  return{key,peer,result,signature,auth};
}
async function rpc(f,invite,phone,path,body,options={}){
  const id=options.id||randomUUID(),request={id,method:body===undefined?'GET':'POST',path,issuedAt:f.now(),...(body!==undefined?{body:JSON.stringify(body)}:{}),...options};
  const result=await invite.room.actions.get('nemo-http').onRequest(request,{peerId:phone.peer});
  if(result.stream){const deadline=Date.now()+3000;let stream;while(!(stream=invite.room.streams.get(id))?.done){if(Date.now()>deadline)throw new Error('Synthetic stream timeout');await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(stream.error,undefined);result.body=Buffer.concat(stream.chunks).toString();}
  if(result.body)result.data=JSON.parse(result.body);return result;
}
async function paired(f,profile){const invite=await invitation(f,profile),phone=await prove(f,invite);assert.equal(phone.result.authenticated,true);const result=await rpc(f,invite,phone,'/api/pair',{code:invite.descriptor.invite,expectedProfileId:profile.id,deviceName:'Synthetic phone'});assert.equal(result.status,200);return{invite,phone,device:result.data.device};}

test('phone access defaults off and never opens discovery during normal startup',async t=>{const f=await fixture(t);assert.equal(f.app.phoneLink.status().enabled,false);assert.equal(f.wire.opens,0);assert.equal(f.saved,null);});
test('public connection proof binds fresh nonces and both actual peer identities',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),invite=await invitation(f,owner),phone=await prove(f,invite);
  assert.equal(phone.result.authenticated,true);
  assert.equal((await phone.auth({kind:'prove',signature:phone.signature},{peerId:phone.peer})).error.code,'LINK_PROOF');
  assert.equal((await phone.auth({kind:'prove',signature:phone.signature},{peerId:'other-peer-12345'})).error.code,'LINK_PROOF');
});
test('copying room secrets and peer IDs cannot move a proof to another DTLS channel',async t=>{
  const f=await fixture(t),link=await paired(f,await f.app.profiles.owner());
  link.invite.room.connection.remoteDescription.sdp='a=fingerprint:sha-256 '+Array(32).fill('CC').join(':')+'\r\n';
  const result=await rpc(f,link.invite,link.phone,'/api/conversation');assert.equal(result.error.code,'LINK_CHANNEL');
  assert.throws(()=>channelBinding({localDescription:{sdp:'a=fingerprint:sha-1 AA'},remoteDescription:{sdp:''}}));
});
test('QR preview does not consume an invitation; confirming binds one browser key',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),invite=await invitation(f,owner),a=await prove(f,invite,'phone-aaaaaaaa'),b=await prove(f,invite,'phone-bbbbbbbb');
  assert.equal((await rpc(f,invite,a,'/api/pair/preview',{code:invite.descriptor.invite})).data.profile.id,owner.id);
  assert.equal((await f.app.profiles.previewInvite(invite.descriptor.invite)).profile.id,owner.id);
  const pairedResult=await rpc(f,invite,a,'/api/pair',{code:invite.descriptor.invite,expectedProfileId:owner.id});assert.equal(pairedResult.status,200);
  assert.equal((await rpc(f,invite,b,'/api/session')).error.code,'LINK_DEVICE');
  assert.equal((await prove(f,invite,'phone-new-key1')).error.code,'LINK_DEVICE');
  assert.equal(JSON.stringify(f.saved).includes('tokenHash'),false);
});
test('two simultaneous profiles retain different chat histories and reject claimed identity',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),other=await f.app.profiles.create('Synthetic adult',false),a=await paired(f,owner),b=await paired(f,other);
  await Promise.all([[a,'I prefer blue.'],[b,'I prefer orange.']].map(([link,message])=>rpc(f,link.invite,link.phone,'/api/chat',{message,requestId:randomUUID()})));
  const[historyA,historyB]=await Promise.all([rpc(f,a.invite,a.phone,'/api/conversation'),rpc(f,b.invite,b.phone,'/api/conversation')]);
  assert.match(JSON.stringify(historyA.data),/I prefer blue/);assert.doesNotMatch(JSON.stringify(historyA.data),/I prefer orange/);
  assert.match(JSON.stringify(historyB.data),/I prefer orange/);assert.doesNotMatch(JSON.stringify(historyB.data),/I prefer blue/);
  assert.equal((await rpc(f,b.invite,b.phone,'/api/conversation',undefined,{expectedProfile:owner.id})).error.code,'PROFILE_CHANGED');
  assert.doesNotMatch(JSON.stringify(f.saved),/I prefer/);
});
test('transport refuses mutation replays, persists receipts and keeps domain request IDs intact',async t=>{
  const f=await fixture(t),link=await paired(f,await f.app.profiles.owner()),id=randomUUID(),body={message:'Synthetic once',requestId:randomUUID()};
  const first=await rpc(f,link.invite,link.phone,'/api/chat',body,{id});assert.equal(first.status,202);
  assert.equal((await rpc(f,link.invite,link.phone,'/api/chat',body,{id})).error.code,'LINK_RECONCILE');
  const retry=await rpc(f,link.invite,link.phone,'/api/chat',body);assert.equal(retry.data.runId,first.data.runId);
  assert.ok(f.saved.links[0].receipts.some(x=>x.id===id));
});
test('signed-in device expiry, owner revocation and profile suspension stop transport access',async t=>{
  const f=await fixture(t),other=await f.app.profiles.create('Synthetic private',false),link=await paired(f,other);
  assert.equal((await rpc(f,link.invite,link.phone,'/api/session')).data.profile.id,other.id);
  await f.app.profiles.disable(other.id,true);
  assert.equal((await rpc(f,link.invite,link.phone,'/api/session')).error.code,'LINK_AUTH');
  await f.app.profiles.disable(other.id,false);
  assert.equal((await rpc(f,link.invite,link.phone,'/api/session')).error.code,'LINK_AUTH');
});
test('expired QR and mismatched profile cannot consume the intended invitation',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),invite=await invitation(f,owner),phone=await prove(f,invite);
  assert.equal((await rpc(f,invite,phone,'/api/pair',{code:invite.descriptor.invite,expectedProfileId:randomUUID()})).error.code,'PAIR_CHANGED');
  assert.equal((await f.app.profiles.previewInvite(invite.descriptor.invite)).profile.id,owner.id);
  f.advance(600001);assert.equal((await prove(f,invite,'expired-peer-1')).error.code,'LINK_REVOKED');
});
test('phone RPC cannot reach setup, passkeys, arbitrary URLs, calendar uploads or encoded traversal',()=>{
  for(const path of ['/api/setup/status','http://127.0.0.1:22/','/api/calendar/import','/api/passkeys/authentication/verify','/api/phone-link/configure','/api/history/%2e%2e/setup','/api/history/../setup'])assert.throws(()=>validateRequest({id:randomUUID(),issuedAt:Date.now(),method:'GET',path},Date.now()));
});
test('an HTTP caller cannot forge the private gateway dispatch capability',async t=>{
  const f=await fixture(t),response=await fetch(f.base+'/api/session',{headers:{'X-Nemo-Link-Dispatch':'a'.repeat(64)}});assert.equal(response.status,403);
});
test('logout returns a minimal receipt and permanently revokes the linked phone',async t=>{
  const f=await fixture(t),link=await paired(f,await f.app.profiles.owner());const result=await rpc(f,link.invite,link.phone,'/api/logout',{});assert.equal(result.data.ok,true);assert.equal(await f.app.profiles.deviceActive(link.device.id,result.data.profileId||f.saved.links[0].profileId),false);assert.equal((await rpc(f,link.invite,link.phone,'/api/session')).error.code,'LINK_AUTH');
});
test('disabling the transport closes rooms while preserving HTTP access and saved profiles',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),link=await paired(f,owner);await f.app.phoneLink.disable();assert.equal(link.invite.room.closed,true);assert.equal((await fetch(f.base+'/api/health')).status,200);assert.equal((await f.app.profiles.profile(owner.id)).id,owner.id);assert.equal(f.app.phoneLink.status().enabled,false);
});
test('TURN REST credentials expire and do not disclose the relay shared secret',()=>{
  const turn=validateTurn({urls:['turns:relay.example.test:443?transport=tcp'],sharedSecret:'synthetic-secret-'.repeat(3)}),now=Date.now(),grant=turnGrant(turn,'synthetic-device',now);
  assert.ok(grant.expiresAt>now&&grant.expiresAt<=now+600000);const server=grant.iceServers[0];assert.equal(server.credential,createHmac('sha1',turn.sharedSecret).update(server.username).digest('base64'));assert.doesNotMatch(JSON.stringify(grant),/synthetic-secret/);assert.throws(()=>validateTurn({urls:['https://example.test'],sharedSecret:turn.sharedSecret}));
});
test('discovery control messages are encrypted and authenticated to a private link topic',async()=>{
  const link={room:randomBytes(32).toString('hex'),password:randomBytes(32).toString('hex')},topic=await mailboxTopic(webcrypto,link),value={kind:'synthetic',nonce:randomBytes(32).toString('hex')},sealed=await sealMailbox(webcrypto,link,topic,value);
  assert.deepEqual(await openMailbox(webcrypto,link,topic,sealed),value);assert.doesNotMatch(sealed,/synthetic/);await assert.rejects(openMailbox(webcrypto,{...link,password:randomBytes(32).toString('hex')},topic,sealed));
});
test('phone frontend readiness requires a bounded static protocol marker',async()=>{
  const valid=()=>new Response(JSON.stringify({service:'nemo-phone-app',protocol:1,static:true}),{headers:{'content-type':'application/json'}});
  assert.equal(await verifyPhoneFrontend('https://phone.example.test',async(url,options)=>{assert.equal(url,'https://phone.example.test/phone-app.json');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return valid();}),true);
  for(const body of ['{}','x'.repeat(2100),JSON.stringify({service:'nemo-phone-app',protocol:2,static:true})])assert.equal(await verifyPhoneFrontend('https://phone.example.test',async()=>new Response(body,{headers:{'content-type':'application/json'}})),false);
});
test('failed protected storage cannot silently enable phone access, and retry can recover',async t=>{
  const f=await fixture(t);await f.app.phoneLink.configure({appOrigin:'https://phone.example.test'});
  const save=f.secrets.save;f.secrets.save=async()=>{throw new Error('Synthetic storage failure');};
  await assert.rejects(f.app.phoneLink.enable());assert.equal(f.app.phoneLink.status().enabled,false);assert.equal(f.wire.opens,0);
  f.secrets.save=save;await f.app.phoneLink.enable();const link=await paired(f,await f.app.profiles.owner());assert.equal(link.phone.result.authenticated,true);
});
test('only a local authenticated owner can change the phone service; relay secret stays protected',async t=>{
  const f=await fixture(t),owner=await f.app.profiles.owner(),other=await f.app.profiles.create('Synthetic member',false);
  async function cookie(profile){const invite=await f.app.profiles.invite(profile.id),reply=await f.app.profiles.redeem(invite.code);return 'nemo_session='+reply.token;}
  const memberCookie=await cookie(other),ownerCookie=await cookie(owner);
  async function configure(cookieValue,id,body){return fetch(f.base+'/api/phone-link/configure',{method:'POST',headers:{cookie:cookieValue,'X-Nemo-Profile':id,'X-Nemo-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)});}
  assert.equal((await configure(memberCookie,other.id,{appOrigin:'https://phone.example.test'})).status,403);
  const sharedSecret='synthetic-owner-only-'.repeat(3),reply=await configure(ownerCookie,owner.id,{appOrigin:'https://phone.example.test',turn:{urls:['turns:relay.example.test:443?transport=tcp'],sharedSecret}});
  assert.equal(reply.status,200);assert.doesNotMatch(await reply.text(),/synthetic-owner-only/);assert.equal(f.saved.turn.sharedSecret,sharedSecret);assert.equal(f.app.phoneLink.status().relayConfigured,true);
});
test('a relay grant requires the paired key and a valid host signature, even before WebRTC connects',async()=>{
  const host=await keys(),phone=await keys(),other=await keys(),record={id:randomUUID(),room:randomBytes(32).toString('hex'),password:randomBytes(32).toString('hex'),clientKey:phone.publicKey};
  const topic=await mailboxTopic(webcrypto,record),sent=[];let socket,allowed=true;
  class FakeSocket extends EventTarget{readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(message){sent.push(JSON.parse(message));}close(){this.readyState=3;}}
  const nostr={subscribe:(id,topic)=>JSON.stringify(['REQ',id,{'#x':[topic]}]),createEvent:async(topic,content)=>JSON.stringify(['EVENT',{tags:[['x',topic]],content}])};
  const mailbox=await createHostMailbox({settings:{relays:['wss://synthetic.example.test']},links:()=>[record],active:async()=>allowed,hostSigningKey:host.privateKey,grant:()=>turnGrant({urls:['turn:relay.example.test:3478?transport=udp'],sharedSecret:'synthetic-secret-'.repeat(3)},record.id,Date.now()),nostr,socketFactory:()=>{socket=new FakeSocket();return socket;}});
  try{
    async function inject(key){const request={kind:'ice-request',id:record.id,nonce:randomBytes(32).toString('hex'),issuedAt:Date.now(),clientKey:key.publicKey};request.signature=await signProof(webcrypto,key.privateKey,iceRequestText(request));const content=await sealMailbox(webcrypto,record,topic,request);socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(['EVENT','nemo-ice',{tags:[['x',topic]],content}])}));return request;}
    const request=await inject(phone);const until=Date.now()+1000;while(!sent.some(x=>x[0]==='EVENT')){if(Date.now()>until)throw new Error('No synthetic relay grant');await new Promise(resolve=>setTimeout(resolve,5));}
    const event=sent.find(x=>x[0]==='EVENT'),reply=await openMailbox(webcrypto,record,topic,event[1].content);
    assert.equal(reply.nonce,request.nonce);assert.equal(await verifyProof(webcrypto,host.publicKey,reply.signature,iceReplyText(reply)),true);assert.doesNotMatch(JSON.stringify(reply),/synthetic-secret/);
    sent.length=0;await inject(other);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(sent.some(x=>x[0]==='EVENT'),false);
    allowed=false;await inject(phone);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(sent.some(x=>x[0]==='EVENT'),false);
  }finally{mailbox.close();}
});

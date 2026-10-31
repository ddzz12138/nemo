import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProfileStore } from '../lib/profile-store.mjs';
import { createPasskeys } from '../lib/passkeys.mjs';

async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-passkeys-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let time=1000, sequence=0, verifiedCounter=1;const store=await createProfileStore({dataDir,now:()=>time});
  const owner=await store.owner(), other=await store.create('Other person');
  async function authFor(profile){const invitation=await store.invite(profile.id);const result=await store.redeem(invitation.code);return{profile:await store.profile(profile.id),device:result.device};}
  const auth=await authFor(owner), calls=[];
  const webauthn={
    async generateRegistrationOptions(input){calls.push(input);return{challenge:'fixture-registration-'+(++sequence)};},
    async verifyRegistrationResponse(input){calls.push(input);if(input.response?.bad)throw new Error('SYNTHETIC_INTERNAL_DIAGNOSTIC');return{verified:true,registrationInfo:{userVerified:true,credential:{id:'synthetic-key-'+input.response.key,publicKey:Buffer.from('synthetic-public-key'),counter:0,transports:['internal']},credentialDeviceType:'multiDevice',credentialBackedUp:true}};},
    async generateAuthenticationOptions(input){calls.push(input);return{challenge:'fixture-authentication-'+(++sequence)};},
    async verifyAuthenticationResponse(input){calls.push(input);return{verified:true,authenticationInfo:{userVerified:true,credentialID:input.response.id,newCounter:verifiedCounter++,credentialDeviceType:'multiDevice',credentialBackedUp:true}};},
  };
  const service=createPasskeys({store,publicOrigin:'https://nemo.example.test',now:()=>time,webauthn});t.after(()=>service.close());
  const req=(cookie='',origin='https://nemo.example.test')=>({method:'POST',headers:{host:'nemo.example.test',origin,cookie},socket:{remoteAddress:'synthetic-loopback'}});
  const invoke=(path,input={},identity=auth,cookie='')=>service.handle(req(cookie),'/api/passkeys/'+path,identity,input);
  async function register(identity=auth,key='owner') { const begin=await invoke('registration/options',{},identity);return invoke('registration/verify',{response:{key}},identity,begin.cookie.split(';')[0]); }
  async function signIn(profile,key='owner'){const begin=await invoke('authentication/options',{},null);return invoke('authentication/verify',{response:{id:'synthetic-key-'+key,response:{userHandle:Buffer.from(profile.id).toString('base64url')}}},null,begin.cookie.split(';')[0]);}
  return{store,service,req,invoke,auth,owner,other,authFor,register,signIn,calls,tick:ms=>time+=ms};
}

test('passkeys bind to the authenticated person and sign in without a browser-selected profile',async t=>{
  const f=await fixture(t);await f.register();const otherAuth=await f.authFor(f.other);await f.register(otherAuth,'other');
  const result=await f.signIn(f.other,'other');assert.equal(result.body.profile.id,f.other.id);assert.equal((await f.store.authenticate(result.sessionToken)).profile.id,f.other.id);assert.ok(!JSON.stringify(result.body).includes(result.sessionToken));
  assert.equal((await f.store.passkeys(f.owner.id)).length,1);assert.equal((await f.store.passkeys(f.other.id)).length,1);
  assert.equal(f.calls.find(call=>call.authenticatorSelection)?.authenticatorSelection.userVerification,'required');
  const verification=f.calls.find(call=>call.credential);assert.equal(verification.requireUserVerification,true);assert.equal(verification.expectedOrigin,'https://nemo.example.test');assert.equal(verification.expectedRPID,'nemo.example.test');
  await assert.rejects(f.invoke('authentication/options',{},f.auth),{code:'ALREADY_PAIRED'});
  await assert.rejects(f.invoke('registration/options',{profileId:f.other.id}),{code:'PASSKEY_INPUT'});
});

test('passkey challenges are origin/cookie/session-bound, expiring and consumed once',async t=>{
  const f=await fixture(t);const start=await f.invoke('registration/options');const cookie=start.cookie.split(';')[0];
  await assert.rejects(f.service.handle(f.req(cookie,'https://attacker.example'),'/api/passkeys/registration/verify',f.auth,{response:{key:'owner'}}),{code:'PASSKEY_ORIGIN'});
  const other=await f.authFor(f.other);await assert.rejects(f.invoke('registration/verify',{response:{key:'owner'}},other,cookie),{code:'PASSKEY_EXPIRED'});
  await assert.rejects(f.invoke('registration/verify',{response:{key:'owner'}},f.auth,cookie),{code:'PASSKEY_EXPIRED'});
  const expiring=await f.invoke('registration/options');f.tick(300_001);await assert.rejects(f.invoke('registration/verify',{response:{key:'owner'}},f.auth,expiring.cookie.split(';')[0]),{code:'PASSKEY_EXPIRED'});
  const fresh=await f.invoke('registration/options');const freshCookie=fresh.cookie.split(';')[0];await f.invoke('registration/verify',{response:{key:'owner'}},f.auth,freshCookie);await assert.rejects(f.invoke('registration/verify',{response:{key:'owner'}},f.auth,freshCookie),{code:'PASSKEY_EXPIRED'});
});

test('passkey revocation is private, signs out its sessions, and preserves invitation access',async t=>{
  const f=await fixture(t);await f.register();const result=await f.signIn(f.owner);await assert.rejects(f.store.revokePasskey(f.other.id,'synthetic-key-owner'),{code:'PASSKEY_NOT_FOUND'});
  const revoked=await f.store.revokePasskey(f.owner.id,'synthetic-key-owner');assert.equal(revoked.revokedDevices.length,1);assert.equal(await f.store.authenticate(result.sessionToken),null);assert.equal(await f.store.deviceActive(f.auth.device.id,f.owner.id),true);
  await assert.rejects(f.signIn(f.owner),{code:'PASSKEY_VERIFY'});assert.equal((await f.store.passkeys(f.owner.id)).length,0);
  const recovered=await f.authFor(f.owner);assert.equal(recovered.profile.id,f.owner.id);
});

test('failed or forged assertions never expose diagnostics or authenticate a disabled profile',async t=>{
  const f=await fixture(t);const start=await f.invoke('registration/options');await assert.rejects(f.invoke('registration/verify',{response:{bad:true}},f.auth,start.cookie.split(';')[0]),error=>error.code==='PASSKEY_VERIFY'&&!error.message.includes('SYNTHETIC_INTERNAL'));
  const otherAuth=await f.authFor(f.other);await f.register(otherAuth,'other');
  const attempt=await f.invoke('authentication/options',{},null);await assert.rejects(f.invoke('authentication/verify',{response:{id:'synthetic-key-other',response:{userHandle:Buffer.from(f.owner.id).toString('base64url')}}},null,attempt.cookie.split(';')[0]),{code:'PASSKEY_VERIFY'});
  const spoof=await f.invoke('authentication/options',{},null);await assert.rejects(f.invoke('authentication/verify',{profileId:f.owner.id,response:{}},null,spoof.cookie.split(';')[0]),{code:'PASSKEY_INPUT'});
  await f.store.disable(f.other.id,true);await assert.rejects(f.signIn(f.other,'other'),{code:'PASSKEY_VERIFY'});
});

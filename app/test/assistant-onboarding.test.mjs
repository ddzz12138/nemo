import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { get } from 'node:http';
import { createAssistantOnboarding } from '../lib/assistant-onboarding.mjs';
import { CHATGPT_AUTH_URL, CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES, CHATGPT_TOKEN_URL } from '../lib/chatgpt-auth-protocol.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', alg: 'RS256' };
const CLIENT = 'oaiapp_synthetic_nemo_one';
const ACCESS = 'synthetic-chatgpt-access-secret';
const REFRESH = 'synthetic-chatgpt-refresh-secret';
const NOW = Date.parse('2026-10-25T00:00:00Z');
function jwt(claims, key = privateKey) { const a = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url'), b = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${a}.${b}.${sign('sha256', Buffer.from(`${a}.${b}`), key).toString('base64url')}`; }

async function fixture(t, options = {}) {
  let stored = options.stored ? structuredClone(options.stored) : null, time = NOW;
  const browser = [], calls = [], saves = [], connected = [], changes = [];
  const state = { token: null, discovery: null, modelResponse: null, claims: {}, refresh: null, revokeFailure: false, saveFailure: false };
  const store = { async load() { return structuredClone(stored); }, async save(value) { if(state.saveFailure) throw new Error('PRIVATE_STORAGE_DETAIL'); saves.push(structuredClone(value)); stored = structuredClone(value); } };
  const service = await createAssistantOnboarding({ dataDir: 'synthetic-private-data', secretStore: store, timeoutMs: options.timeoutMs || 60_000, now: () => time,
    async openExternal(url) { browser.push(new URL(url)); await options.openExternal?.(url); },
    async onConnected(information) { connected.push(information); await options.onConnected?.(information); },
    async onConnectionChanging() { changes.push(true); await options.onConnectionChanging?.(); },
    async fetchImpl(url, input = {}) {
      const fields = input.body instanceof URLSearchParams ? Object.fromEntries(input.body) : null;
      calls.push({url, input, fields});
      if (url === `${CHATGPT_ISSUER}/.well-known/openid-configuration`) return Response.json(state.discovery || { issuer: CHATGPT_ISSUER, authorization_endpoint: CHATGPT_AUTH_URL, token_endpoint: CHATGPT_TOKEN_URL, jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke` });
      if (url === `${CHATGPT_ISSUER}/.well-known/jwks.json`) return Response.json({keys:[publicJwk]});
      if (url === `${CHATGPT_RESOURCE}/models`) return state.modelResponse ? state.modelResponse(input) : Response.json({ models: [{slug:'hidden-model',visibility:'hide'}, {slug:'synthetic-account-model',display_name:'Included model',visibility:'list'}] });
      if (url === `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`) { if(state.revokeFailure) throw new Error('PRIVATE_REVOCATION_DETAIL'); return state.revoke ? state.revoke(fields,input) : new Response(null,{status:200}); }
      if (url === CHATGPT_TOKEN_URL) {
        if (fields.grant_type === 'refresh_token') return state.refresh ? state.refresh(fields,input) : Response.json({ access_token: ACCESS+'-renewed', refresh_token: REFRESH+'-renewed', token_type:'Bearer',expires_in:3600 });
        const auth = browser.at(-1), seconds = Math.floor(time / 1000);
        const claims = {iss:CHATGPT_ISSUER,aud:fields.client_id,sub:'synthetic-account-one',email:'parent@example.invalid',email_verified:true,iat:seconds,exp:seconds+3600,nonce:auth.searchParams.get('nonce'),...state.claims};
        const result = {access_token:ACCESS,refresh_token:REFRESH,id_token:jwt(claims),token_type:'Bearer',expires_in:3600,scope:CHATGPT_SCOPES};
        return state.token ? state.token(result,fields,input) : Response.json(result);
      }
      throw new Error('Unexpected network request');
    },
  });
  t.after(() => service.close());
  function callback(auth = browser.at(-1), client = CLIENT) { const url = new URL(auth.searchParams.get('redirect_uri')); url.searchParams.set('state',auth.searchParams.get('state')); url.searchParams.set('code','synthetic-single-use-code'); if(client!==null) url.searchParams.set('client_id',client); return url; }
  async function connect(input, client = CLIENT) { await service.begin(input); return fetch(callback(browser.at(-1),client),{redirect:'manual'}); }
  return { service,state,browser,calls,saves,connected,changes,callback,connect,stored:()=>structuredClone(stored),advance:ms=>{time+=ms;} };
}
const exchanges = f => f.calls.filter(call => call.fields?.grant_type === 'authorization_code');
const refreshes = f => f.calls.filter(call => call.fields?.grant_type === 'refresh_token');

test('Nemo registers its own ChatGPT client with PKCE, nonce, a stable host and private verified tokens', async t => {
  const f = await fixture(t); const initial = await f.service.begin(); const auth = f.browser[0];
  assert.equal(initial.connected,false);assert.equal(auth.origin,CHATGPT_ISSUER);assert.equal(auth.pathname,'/api/accounts/authorize');
  assert.equal(auth.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(auth.searchParams.get('agent_name_hint'),'Nemo');assert.match(auth.searchParams.get('ext_agent_host_id'),/^urn:uuid:[a-f0-9-]{36}$/);
  assert.equal(auth.searchParams.get('scope'),CHATGPT_SCOPES);assert.equal(auth.searchParams.get('resource'),CHATGPT_RESOURCE);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.ok(auth.searchParams.get('nonce'));
  const callback=f.callback();assert.equal(callback.pathname,'/auth/callback');assert.equal(callback.hostname,'127.0.0.1');
  const response=await fetch(callback,{redirect:'manual'});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/auth/done');
  const exchange=exchanges(f)[0];assert.equal(exchange.url,CHATGPT_TOKEN_URL);assert.equal(exchange.input.redirect,'error');assert.equal(exchange.fields.client_id,CLIENT);assert.equal(exchange.fields.resource,CHATGPT_RESOURCE);assert.equal(exchange.fields.redirect_uri,auth.searchParams.get('redirect_uri'));assert.equal(exchange.fields.client_secret,undefined);
  assert.equal(createHash('sha256').update(exchange.fields.code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));
  assert.equal(f.saves[1].accounts[0].clientId,CLIENT);assert.equal(f.saves[1].accounts[0].tokens,null);
  assert.equal(f.stored().accounts[0].subject,'synthetic-account-one');assert.equal(f.stored().accounts[0].tokens.accessToken,ACCESS);
  assert.deepEqual(await f.service.credentials(),{provider:'chatgpt',accessToken:ACCESS,model:'synthetic-account-model',clientId:CLIENT});assert.equal(f.connected.length,1);
  assert.equal(f.service.status().connected,true);assert.equal(f.service.status().confirmationRequired,true);
  const publicStatus=JSON.stringify(f.service.status());for(const secret of [ACCESS,REFRESH,f.stored().accounts[0].tokens.idToken,CLIENT,'synthetic-single-use-code'])assert.ok(!publicStatus.includes(secret));
  const completion=await fetch(new URL('/auth/done',callback));assert.ok((await completion.text()).includes('connected'));
  assert.equal((await fetch(callback,{redirect:'manual'})).status,404);assert.equal(exchanges(f).length,1);
});

test('callback state, host, origin, duplicate parameters and issued client ID are checked before exchange',async t=>{
  const f=await fixture(t);await f.service.begin();const valid=f.callback();
  for(const mutate of [u=>u.pathname='/wrong',u=>u.searchParams.set('state','wrong'),u=>u.searchParams.delete('state'),u=>u.searchParams.append('code','duplicate'),u=>u.searchParams.set('client_id','dynamic_agent_client'),u=>u.searchParams.delete('client_id')]){const u=new URL(valid);mutate(u);const result=await fetch(u,{redirect:'manual'});assert.ok([400,403,404].includes(result.status));}
  assert.equal((await fetch(valid,{headers:{Origin:'https://attacker.invalid'}})).status,403);
  const rebound=await new Promise((resolve,reject)=>{get(valid,{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(rebound,403);
  assert.equal(exchanges(f).length,0);assert.equal((await fetch(valid,{redirect:'manual'})).status,303);
});

test('declined consent consumes the attempt without exchanging or accepting callback-provided scope',async t=>{
  const f=await fixture(t);await f.service.begin();const url=f.callback();url.searchParams.delete('code');url.searchParams.set('error','access_denied');url.searchParams.set('scope',CHATGPT_SCOPES);
  assert.equal((await fetch(url,{redirect:'manual'})).status,303);assert.equal(exchanges(f).length,0);assert.equal(await f.service.credentials(),null);assert.equal(f.service.status().phase,'permission-required');
});

test('concurrent callbacks exchange a code only once',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t);f.state.token=async result=>{await gate;return Response.json(result);};await f.service.begin();const url=f.callback();
  const first=fetch(url,{redirect:'manual'});while(!exchanges(f).length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await fetch(url,{redirect:'manual'})).status,404);release();assert.equal((await first).status,303);assert.equal(exchanges(f).length,1);
});

test('expired or abandoned browser attempts cannot be reused and host ID survives retries',async t=>{
  const f=await fixture(t,{timeoutMs:90});await f.service.begin();const old=f.callback(),host=f.browser[0].searchParams.get('ext_agent_host_id');await f.service.begin();
  assert.equal(f.browser[1].searchParams.get('ext_agent_host_id'),host);assert.equal(f.browser[1].searchParams.get('redirect_uri').endsWith('/auth/callback'),true);await assert.rejects(fetch(old));
  await new Promise(resolve=>setTimeout(resolve,110));assert.equal(f.service.status().phase,'expired');assert.equal(await f.service.credentials(),null);
});

for(const [name,claims] of [['issuer',{iss:'https://attacker.invalid'}],['audience',{aud:'oaiapp_other'}],['nonce',{nonce:'wrong'}],['expired',{exp:Math.floor(NOW/1000)-20}],['future issuance',{iat:Math.floor(NOW/1000)+300}],['subject',{sub:''}]])test(`signed but invalid ${name} cannot activate a ChatGPT connection`,async t=>{
  const f=await fixture(t);f.state.claims=claims;await f.connect();assert.equal(f.service.status().connected,false);assert.equal(await f.service.credentials(),null);assert.equal(f.stored().accounts[0].tokens,null);assert.equal(f.connected.length,0);
});

test('an invalid JWT signature and metadata from another trust origin are rejected',async t=>{
  const f=await fixture(t);f.state.token=result=>Response.json({...result,id_token:result.id_token.slice(0,-10)+'aaaaaaaaaa'});await f.connect();assert.equal(await f.service.credentials(),null);
  const other=await fixture(t);other.state.discovery={issuer:CHATGPT_ISSUER,authorization_endpoint:CHATGPT_AUTH_URL,token_endpoint:CHATGPT_TOKEN_URL,jwks_uri:'https://attacker.invalid/keys'};await other.connect();assert.equal(await other.service.credentials(),null);assert.equal(other.calls.some(call=>call.url.startsWith('https://attacker.invalid')),false);
});

test('identity-only sign-in is saved but never enables model discovery or inference',async t=>{
  const f=await fixture(t);f.state.token=result=>Response.json({...result,scope:'openid profile email'});await f.connect();assert.equal(f.service.status().hasAccount,true);assert.equal(f.service.status().planUsageEnabled,false);assert.equal(f.service.status().phase,'permission-required');assert.equal(await f.service.credentials(),null);assert.equal(f.calls.some(call=>call.url.endsWith('/models')),false);
  await f.service.begin();assert.equal(f.browser.at(-1).searchParams.get('prompt'),'consent');assert.equal(f.browser.at(-1).searchParams.get('client_id'),CLIENT);
});

test('invalid_grant keeps the issued registration for a fresh code rather than registering again',async t=>{
  const f=await fixture(t);f.state.token=()=>Response.json({error:'invalid_grant',error_description:'PRIVATE_UPSTREAM_DETAIL'},{status:400});await f.connect();assert.equal(f.stored().accounts[0].clientId,CLIENT);assert.equal(f.service.status().connected,false);
  await f.service.begin();const auth=f.browser.at(-1);assert.equal(auth.searchParams.get('client_id'),CLIENT);assert.equal(auth.searchParams.has('agent_name_hint'),false);assert.equal(JSON.stringify(f.service.status()).includes('PRIVATE_UPSTREAM_DETAIL'),false);
});

test('refresh rotates tokens once for concurrent requests and never expands or requests a new scope',async t=>{
  const f=await fixture(t);await f.connect();f.advance(3_550_000);const [a,b]=await Promise.all([f.service.credentials(),f.service.credentials()]);
  assert.equal(a.accessToken,ACCESS+'-renewed');assert.deepEqual(a,b);assert.equal(refreshes(f).length,1);assert.equal(refreshes(f)[0].fields.client_id,CLIENT);assert.equal(refreshes(f)[0].fields.refresh_token,REFRESH);assert.equal(refreshes(f)[0].fields.scope,undefined);assert.equal(f.stored().accounts[0].tokens.refreshToken,REFRESH+'-renewed');
});

test('terminal refresh clears credentials but retains account mapping, while temporary failures preserve them',async t=>{
  const f=await fixture(t);await f.connect();f.advance(3_600_001);f.state.refresh=()=>Response.json({error:'invalid_grant'},{status:400});await assert.rejects(f.service.credentials(),{code:'CHATGPT_SIGN_IN_REQUIRED'});assert.equal(f.stored().accounts[0].tokens,null);assert.equal(f.stored().accounts[0].clientId,CLIENT);assert.equal(await f.service.credentials(),null);
  const other=await fixture(t);await other.connect();other.advance(3_600_001);other.state.refresh=()=>{throw new Error('PRIVATE_NETWORK_DETAIL');};await assert.rejects(other.service.credentials(),{code:'CHATGPT_UNAVAILABLE'});assert.equal(other.stored().accounts[0].tokens.refreshToken,REFRESH);assert.equal(JSON.stringify(other.service.status()).includes('PRIVATE_NETWORK_DETAIL'),false);
});

test('a refresh without a replacement refresh token retains the current renewable token',async t=>{
  const f=await fixture(t);await f.connect();f.advance(3_550_000);f.state.refresh=()=>Response.json({access_token:ACCESS+'-without-rotation',token_type:'Bearer',expires_in:3600});
  const connection=await f.service.credentials();assert.equal(connection.accessToken,ACCESS+'-without-rotation');assert.equal(f.stored().accounts[0].tokens.refreshToken,REFRESH);
});

test('saved startup failure can be retried without browser sign-in or duplicate registration',async t=>{
  let broken=true;const f=await fixture(t,{onConnected:()=>{if(broken)throw new Error('synthetic startup failure');}});await f.connect();assert.equal(f.service.status().connected,true);assert.equal(f.service.status().phase,'error');broken=false;
  const result=await f.service.retryConnection();assert.equal(result.phase,'connected');assert.equal(f.browser.length,1);assert.equal(exchanges(f).length,1);assert.equal(f.connected.length,2);
});

test('plan-use confirmation survives restart and sign-in with the existing registration',async t=>{
  const f=await fixture(t);await f.connect();await f.service.begin({action:'acknowledge'});assert.equal(f.service.status().confirmationRequired,false);const saved=f.stored();
  const restarted=await fixture(t,{stored:saved});assert.equal(restarted.service.status().planUsageAcknowledged,true);assert.equal(restarted.browser.length,0);await restarted.service.begin();const auth=restarted.browser[0];assert.equal(auth.searchParams.get('client_id'),CLIENT);assert.equal(auth.searchParams.has('agent_name_hint'),false);assert.equal(auth.searchParams.get('ext_agent_host_id'),saved.hostId);assert.equal(auth.searchParams.get('id_token_hint'),saved.accounts[0].tokens.idToken);
  await fetch(restarted.callback(auth,null),{redirect:'manual'});assert.equal(restarted.service.status().confirmationRequired,false);
});

test('sign-out revokes the renewable session, clears local tokens and preserves the issued client',async t=>{
  const f=await fixture(t);await f.connect();const result=await f.service.begin({action:'signout'});assert.equal(result.connected,false);assert.equal(await f.service.credentials(),null);assert.equal(f.stored().accounts[0].tokens,null);assert.equal(f.stored().accounts[0].clientId,CLIENT);
  const call=f.calls.find(item=>item.url.endsWith('/oauth/revoke'));assert.equal(call.fields.token,REFRESH);assert.equal(call.fields.client_id,CLIENT);assert.equal(call.fields.token_type_hint,'refresh_token');
  await f.service.begin();assert.equal(f.browser.at(-1).searchParams.get('client_id'),CLIENT);assert.equal(f.browser.at(-1).searchParams.has('id_token_hint'),false);
});

test('offline remote revocation is reported truthfully after local sign-out',async t=>{
  const f=await fixture(t);await f.connect();f.state.revokeFailure=true;const result=await f.service.signOut();assert.equal(result.connected,false);assert.match(result.message,/Remote sign-out was not confirmed/);assert.equal(f.stored().accounts[0].tokens,null);assert.equal(f.calls.filter(call=>call.url.endsWith('/oauth/revoke')).length,2);
});

test('separate registrations with the same email retain separate tokens, labels and active identities',async t=>{
  const f=await fixture(t);await f.connect();const first=f.service.status().activeAccountId;f.state.claims={sub:'synthetic-account-two'};await f.connect({action:'new'},'oaiapp_synthetic_nemo_two');const second=f.service.status().activeAccountId;assert.notEqual(first,second);assert.equal(f.service.status().accounts.length,2);assert.notEqual(f.service.status().accounts[0].label,f.service.status().accounts[1].label);
  await f.service.begin({action:'select',accountId:first});assert.equal(f.service.status().activeAccountId,first);assert.equal((await f.service.credentials()).clientId,CLIENT);
  await f.service.begin();f.state.claims={sub:'synthetic-account-two'};await fetch(f.callback(f.browser.at(-1),null),{redirect:'manual'});assert.equal(f.service.status().activeAccountId,first);assert.equal(f.stored().accounts.find(item=>item.id===first).subject,'synthetic-account-one');assert.equal(f.service.status().phase,'error');
});

test('legacy OpenRouter credentials never authorize this desktop or perform paid requests',async t=>{
  const legacy={version:1,provider:'openrouter',apiKey:'sk-or-v1-legacy-secret'};const f=await fixture(t,{stored:legacy});assert.equal(f.service.status().connected,false);assert.equal(await f.service.credentials(),null);assert.match(f.service.status().message,/previous OpenRouter connection will not be used/);assert.equal(f.calls.length,0);assert.deepEqual(f.stored(),legacy);await f.connect();assert.equal(f.stored().provider,'chatgpt');assert.equal(f.calls.some(call=>call.url.includes('openrouter')),false);
});

test('a full-sized account model catalog completes sign-in without importing its instructions', async t => {
  const f = await fixture(t);
  const body = new TextEncoder().encode(JSON.stringify({ models: [
    { slug: 'hidden-model', visibility: 'hide' },
    { slug: 'large-catalog-model', visibility: 'list', base_instructions: 'metadata-only-'.repeat(44_000) },
  ] }));
  assert.ok(body.length > 568_000, 'exercise the size of the real account catalog');
  f.state.modelResponse = () => new Response(new ReadableStream({
    start(controller) { for (let offset = 0; offset < body.length; offset += 8192) controller.enqueue(body.slice(offset, offset + 8192)); controller.close(); },
  }), { headers: { 'content-type': 'application/json' } });
  await f.connect();
  assert.equal(f.service.status().phase, 'connected');
  assert.deepEqual(await f.service.credentials(), { provider: 'chatgpt', accessToken: ACCESS, model: 'large-catalog-model', clientId: CLIENT });
  assert.deepEqual(f.connected, [{ planUsageEnabled: true }]);
  assert.equal(exchanges(f).length, 1); assert.equal(refreshes(f).length, 0);
  assert.equal(JSON.stringify(f.service.status()).includes('metadata-only'), false);
  assert.equal(JSON.stringify(f.stored()).includes('metadata-only'), false);
});

test('an oversized catalog remains bounded and retry recovers using the saved grant', async t => {
  const f = await fixture(t);
  const body = new TextEncoder().encode(JSON.stringify({ models: [{ slug: 'oversized-model', visibility: 'list', base_instructions: 'x'.repeat(4 * 1024 * 1024 + 512_000) }] }));
  let offset = 0, cancelled = false;
  f.state.modelResponse = () => new Response(new ReadableStream({
    pull(controller) { const next = Math.min(offset + 65_536, body.length); controller.enqueue(body.slice(offset, next)); offset = next; if (offset === body.length) controller.close(); },
    cancel() { cancelled = true; },
  }));
  await f.connect();
  assert.equal(f.service.status().phase, 'error');
  assert.equal(f.service.status().connected, true, 'the saved grant remains available for retry');
  assert.equal(f.stored().accounts[0].tokens.accessToken, ACCESS);
  assert.equal(f.stored().accounts[0].tokens.refreshToken, REFRESH);
  assert.equal(f.connected.length, 0); assert.equal(cancelled, true);
  assert.ok(offset < body.length, 'stop reading once the catalog exceeds its cap');
  f.state.modelResponse = () => Response.json({ models: [{ slug: 'recovered-model', visibility: 'list', base_instructions: 'x'.repeat(568_000) }] });
  assert.equal((await f.service.retryConnection()).phase, 'connected');
  assert.equal((await f.service.credentials()).model, 'recovered-model');
  assert.equal(f.browser.length, 1); assert.equal(exchanges(f).length, 1); assert.equal(refreshes(f).length, 0);
});

test('unavailable catalog and unsafe protected writes cannot release active credentials',async t=>{
  const f=await fixture(t);f.state.modelResponse=()=>Response.json({models:[]});await f.connect();await assert.rejects(f.service.credentials(),{code:'CHATGPT_NOT_ELIGIBLE'});assert.equal(f.service.status().phase,'error');
  const other=await fixture(t);await other.service.begin();other.state.saveFailure=true;await fetch(other.callback(),{redirect:'manual'});assert.equal(other.service.status().connected,false);await assert.rejects(other.service.credentials(),{code:'CHATGPT_UNAVAILABLE'});assert.equal(JSON.stringify(other.service.status()).includes('PRIVATE_STORAGE_DETAIL'),false);
});

test('a revoked model-list token returns setup to sign-in instead of looping through saved startup retry',async t=>{
  const f=await fixture(t);await f.connect();f.advance(301_000);f.state.modelResponse=()=>Response.json({error:{message:'PRIVATE_REVOKED_DETAIL'}},{status:401});
  await assert.rejects(f.service.credentials(),{code:'CHATGPT_SIGN_IN_REQUIRED'});assert.equal(f.service.status().connected,false);assert.equal(f.service.status().phase,'reconnect-required');assert.equal(f.stored().accounts[0].tokens,null);assert.equal(JSON.stringify(f.service.status()).includes('PRIVATE_REVOKED_DETAIL'),false);
});

test('refreshed identity must still match the selected account and a removed grant never returns credentials',async t=>{
  const f=await fixture(t);await f.connect();f.advance(3_550_000);f.state.refresh=()=>Response.json({access_token:ACCESS+'-bad',refresh_token:REFRESH+'-bad',token_type:'Bearer',expires_in:3600,id_token:jwt({iss:CHATGPT_ISSUER,aud:CLIENT,sub:'another-subject',iat:Math.floor((NOW+3_550_000)/1000),exp:Math.floor((NOW+3_550_000)/1000)+3600})});
  await assert.rejects(f.service.credentials(),{code:'CHATGPT_UNAVAILABLE'});assert.equal(f.stored().accounts[0].tokens.accessToken,ACCESS);
  f.state.refresh=()=>Response.json({access_token:ACCESS+'-no-grant',refresh_token:REFRESH+'-no-grant',token_type:'Bearer',expires_in:3600,scope:'openid email profile'});
  assert.equal(await f.service.credentials(),null);assert.equal(f.service.status().planUsageEnabled,false);assert.equal(f.service.status().phase,'permission-required');
});

test('sign-out stops local inference before waiting for remote revocation', async t => {
  let unblock, started = false;
  const remoteGate = new Promise(resolve => { unblock = resolve; }); t.after(() => unblock());
  const f = await fixture(t); await f.connect(); const changes = f.changes.length;
  f.state.revoke = async () => { assert.equal(f.changes.length, changes + 1); started = true; await remoteGate; return new Response(null, { status: 200 }); };
  const signingOut = f.service.signOut();
  while (!started) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().connected, false);
  assert.equal(await f.service.credentials(), null);
  unblock(); await signingOut;
  assert.equal(f.stored().accounts[0].tokens, null);
});

test('switching a saved account stops old inference before model discovery', async t => {
  let unblock, started = false;
  const catalogGate = new Promise(resolve => { unblock = resolve; }); t.after(() => unblock());
  const f = await fixture(t); await f.connect(); const first = f.service.status().activeAccountId;
  f.state.claims = { sub: 'synthetic-account-two' }; await f.connect({ action: 'new' }, 'oaiapp_synthetic_nemo_two');
  const changes = f.changes.length; f.advance(301_000);
  f.state.modelResponse = async () => { assert.equal(f.changes.length, changes + 1); started = true; await catalogGate; return Response.json({ models: [{ slug: 'synthetic-selected-model', visibility: 'list' }] }); };
  const selecting = f.service.selectAccount(first);
  while (!started) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.status().connected, false);
  unblock(); await selecting;
  assert.equal(f.service.status().activeAccountId, first);
  assert.equal((await f.service.credentials()).clientId, CLIENT);
});

test('a newly verified grant pauses the old connection before activation and notifies only plan readiness', async t => {
  let service, observed = 0;
  const f = await fixture(t, { onConnectionChanging: async () => { observed++; assert.equal(service.status().connected, false); assert.equal(await service.credentials(), null); } });
  service = f.service; await f.connect();
  assert.equal(observed, 1);
  assert.deepEqual(f.connected, [{ planUsageEnabled: true }]);
  const first = service.status().activeAccountId;
  f.state.claims = { sub: 'synthetic-account-two' }; await f.connect({ action: 'new' }, 'oaiapp_synthetic_nemo_two');
  assert.equal(observed, 2); assert.notEqual(service.status().activeAccountId, first);
  assert.deepEqual(f.connected.at(-1), { planUsageEnabled: true });
});

test('late inference authorization failure exposes saved-account recovery and refreshes only on explicit retry', async t => {
  const f = await fixture(t); await f.connect(); const browsers = f.browser.length;
  await f.service.reportInferenceFailure('CHATGPT_SIGN_IN_REQUIRED');
  assert.equal(f.service.status().phase, 'error');
  assert.equal(f.service.status().connected, true);
  assert.equal(refreshes(f).length, 0);
  const recovered = await f.service.retryConnection();
  assert.equal(recovered.phase, 'connected'); assert.equal(refreshes(f).length, 1);
  assert.equal(f.browser.length, browsers);
  assert.equal((await f.service.credentials()).accessToken, ACCESS + '-renewed');
});

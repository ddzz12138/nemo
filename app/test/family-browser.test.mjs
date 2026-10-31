import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFamilyServer} from '../lib/family-server.mjs';

// Optional real-browser check: install Playwright separately or point this at
// the test runner's package.json. No production/browser dependency is shipped.
let chromium;try{({chromium}=createRequire(process.env.NEMO_TEST_BROWSER_PACKAGE||import.meta.url)('playwright'));}catch{}
test('real WebAuthn round trips bind two passkeys to private profiles and show visible child review', {skip:!chromium,timeout:60_000},async t=>{
  const prefix=fileURLToPath(new URL('./.tmp-family-browser-',import.meta.url)),dataDir=await mkdtemp(prefix);
  const app=await createFamilyServer({dataDir,publicDir:fileURLToPath(new URL('../public',import.meta.url)),provider:{status:()=>({connected:true,verified:true}),async run(input){return{text:'Synthetic answer for '+input.profileId}}},logger(){}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://localhost:${app.server.address().port}`;
  let browser;
  t.after(async()=>{await browser?.close();await app.close();assert.equal(dirname(resolve(dataDir)),dirname(resolve(prefix)));assert.ok(dataDir.startsWith(prefix));await rm(dataDir,{recursive:true,force:true});});
  browser=await chromium.launch({headless:true,...(process.env.NEMO_TEST_BROWSER_CHANNEL?{channel:process.env.NEMO_TEST_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  async function evidence(name){if(!process.env.NEMO_BROWSER_EVIDENCE_DIR)return;const directory=resolve(process.env.NEMO_BROWSER_EVIDENCE_DIR);await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png'),fullPage:true});}
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  async function pair(profile){const invitation=await app.profiles.invite(profile.id);const result=await context.request.post(base+'/api/pair',{headers:{'X-Nemo-Request':'1'},data:{code:invitation.code,deviceName:'Synthetic browser'}});assert.equal(result.status(),200);}
  async function signOut(){await page.goto(base+'/sign-in.html');await page.locator('#switchPerson').waitFor({state:'visible'});await page.locator('#switchPerson').click();await page.locator('#signInPasskey').waitFor({state:'visible'});await page.waitForFunction(()=>!window.NemoIdentity.profile);}
  async function register(label){await page.goto(base+'/passkeys.html');await page.locator('#passkeyLabel').fill(label);await page.locator('#addPasskey').click();await page.waitForFunction(()=>document.getElementById('passkeyStatus').textContent==='Passkey saved for your profile.');}
  async function signIn(profile){await page.goto(base+'/sign-in.html');await page.locator('#signInPasskey').click();await page.waitForURL(base+'/');await page.waitForFunction(()=>window.NemoIdentity?.profile);const session=await page.evaluate(async()=>(await (await window.nemoFetch('/api/session')).json()));assert.equal(session.profile.id,profile.id);return session;}
  const owner=await app.profiles.owner();await pair(owner);await register('Synthetic owner key');
  await evidence('passkeys');
  let ownerCredential=(await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials[0];assert.ok(ownerCredential);
  await signOut();await signIn(owner);ownerCredential=(await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials[0];await signOut();
  await cdp.send('WebAuthn.removeCredential',{authenticatorId,credentialId:ownerCredential.credentialId});
  const child=await app.profiles.create('Synthetic learner',true);await pair(child);await register('Synthetic learner key');
  await page.goto(base+'/');await page.locator('#nemoReviewNotice').waitFor();
  assert.match(await page.locator('#nemoReviewNotice').textContent(),/owner can read your chats/);
  const layout=await page.evaluate(()=>{const notice=document.getElementById('nemoReviewNotice').getBoundingClientRect(),header=document.querySelector('.nemo-header').getBoundingClientRect();return{noticeBottom:notice.bottom,headerTop:header.top,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(layout.headerTop>=layout.noticeBottom-1,'review notice must not cover chat controls');assert.equal(layout.overflow,false);
  await evidence('child-chat');
  await signOut();await signIn(child);
  const childCredential=(await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials[0];
  await signOut();await cdp.send('WebAuthn.clearCredentials',{authenticatorId});
  await cdp.send('WebAuthn.addCredential',{authenticatorId,credential:ownerCredential});await signIn(owner);
  // Make an accidental second startup read finish after navigation's identity
  // update. It used to reject that response and leave Family without profiles.
  let familySessionReads=0;
  await page.route('**/api/session',async route=>{familySessionReads++;if(familySessionReads>1)await new Promise(done=>setTimeout(done,150));await route.continue();});
  await page.goto(base+'/family.html');await page.waitForFunction(()=>window.NemoIdentity?.profile);
  assert.equal(familySessionReads,1,'Family and navigation must share their initial session lookup');
  await page.getByText('Choose tools for this child',{exact:true}).click();
  await page.unroute('**/api/session');
  const childCard=page.locator('.profile-card').filter({has:page.getByRole('heading',{name:child.name,exact:true})});
  await childCard.getByLabel('Calendar',{exact:true}).check();
  await page.waitForFunction(async id=>{const result=await (await window.nemoFetch('/api/profiles')).json();return result.profiles.find(item=>item.id===id)?.capabilityGrants.calendar===true;},child.id);
  await page.waitForFunction(id=>{const details=document.querySelector(`details[data-profile="${id}"]`);return details?.open&&![...details.querySelectorAll('input')].some(input=>input.disabled);},child.id);
  await evidence('family-tools');
  await childCard.getByRole('link',{name:'Review History & Memory ↗'}).click();await page.locator('#reviewStatus').filter({hasText:'Read only'}).waitFor();
  assert.equal((await app.profiles.parentalReviewLog(child.id)).length,1);
  await evidence('family-review');
  await page.goto(base+'/passkeys.html');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Remove passkey'}).click();await page.waitForURL(base+'/sign-in.html');
  // The removed server key cannot sign in even if the authenticator still has it.
  await page.locator('#signInPasskey').click();await page.locator('#passkeyStatus').filter({hasText:'could not verify'}).waitFor();
  assert.equal((await context.request.get(base+'/api/session').then(response=>response.json())).authenticated,false);
  assert.equal(errors.length,0,errors.join('\n'));assert.ok(childCredential);
  await evidence('passkey-revoked');
});

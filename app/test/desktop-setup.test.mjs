import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createFamilyServer } from '../lib/family-server.mjs';
import { createHostSetupServer } from '../lib/host-setup-server.mjs';
const require = createRequire(import.meta.url);
const { CHATGPT_USAGE_URL, parseBootstrap, utilityLaunchOptions, allowedExternal, registrationOriginForLaunch, setupRequest, localInvitationUrl, openLocalSpace, loginItemOptions } = require('../desktop/contracts.cjs');
const pairSource = await readFile(new URL('../public/pair.js', import.meta.url), 'utf8');

function pairHarness({ hash = '#invite=ABCD-EFGH-JKLM-NPQR', current = null, previewError, protocol='https:',hostname='nemo.example',search='' } = {}) {
  const nodes = new Map(), calls = [], events = [], listeners = {};
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, hidden:false, textContent:'', disabled:false, handlers:{}, addEventListener(type, fn) { this.handlers[type]=fn; } });
    return nodes.get(id);
  }
  const profile = { id:'intended-profile',name:'Asha',parentalReview:true };
  const window = {
    location:{hash,pathname:'/pair.html',protocol,hostname,search},
    history:{replaceState(_state,_title,path) { events.push('clear-fragment'); window.location.hash=''; assert.equal(path,'/pair.html'); }},
    addEventListener(type,fn) { listeners[type]=fn; },
    NemoIdentity:{async load() { events.push('load-session'); return {profile:current}; }},
    async nemoFetch(path,options) {
      events.push(path); calls.push({path,options,body:JSON.parse(options.body)});
      if(path==='/api/pair/preview') return previewError ? Response.json(previewError,{status:401}) : Response.json({profile,expiresAt:Date.now()+60_000});
      if(path==='/api/logout') return Response.json({ok:true});
      if(path==='/api/pair') return Response.json({profile});
      throw new Error('Unexpected request: '+path);
    },
  };
  vm.runInNewContext(pairSource,{window,document:{getElementById:node},URLSearchParams,Date,fetch:window.nemoFetch});
  return {nodes,calls,events,window,listeners,async settle(){await new Promise(done=>setImmediate(done));},async click(id){await node(id).handlers.click();}};
}

test('phone scan clears its fragment first and never consumes an invitation without confirmation', async () => {
  const h=pairHarness(); await h.settle();
  assert.equal(h.events[0],'clear-fragment');
  assert.equal(h.window.location.hash,'');
  assert.deepEqual(h.calls.map(call=>call.path),['/api/pair/preview']);
  assert.equal(h.nodes.get('pairHeading').textContent,'Hello, Asha.');
  assert.equal(h.nodes.get('pairReview').hidden,false);
  assert.equal(h.nodes.get('pairConfirmation').hidden,false);
  await h.click('confirmPair');
  const redeemed=h.calls.find(call=>call.path==='/api/pair');
  assert.deepEqual(redeemed.body,{code:'ABCD-EFGH-JKLM-NPQR',expectedProfileId:'intended-profile',deviceName:'Personal phone'});
  assert.equal(redeemed.options.headers['X-Nemo-Request'],'1');
  assert.equal(redeemed.options.headers['Content-Type'],'application/json');
  assert.equal(h.nodes.get('pairSuccess').hidden,false);
  assert.ok(h.calls.every(call=>!call.path.includes('ABCD')));
});

test('an already paired phone must explicitly sign out, then explicitly confirm the intended profile',async()=>{
  const h=pairHarness({current:{id:'other-profile',name:'Sam'}});await h.settle();
  assert.equal(h.nodes.get('pairExisting').hidden,false);
  await h.click('confirmPair');assert.ok(!h.calls.some(call=>call.path==='/api/pair'));
  await h.click('switchProfile');
  assert.equal(h.calls.find(call=>call.path==='/api/logout').options.headers['X-Nemo-Profile'],'other-profile');
  assert.equal(h.nodes.get('pairConfirmation').hidden,false);
  assert.ok(!h.calls.some(call=>call.path==='/api/pair'));
  await h.click('confirmPair');assert.equal(h.calls.filter(call=>call.path==='/api/pair').length,1);
});

test('query strings cannot provide an invitation; expired invitations offer a fresh scan',async()=>{
  const absent=pairHarness({hash:''});await absent.settle();assert.equal(absent.calls.length,0);assert.equal(absent.nodes.get('pairUnavailable').hidden,false);
  const expired=pairHarness({previewError:{code:'PAIR_INVALID',error:'Expired'}});await expired.settle();
  assert.equal(expired.nodes.get('pairUnavailable').hidden,false);
  await expired.click('confirmPair');assert.equal(expired.calls.length,1);
});

test('leaving the pairing page discards the invitation and a late click cannot redeem it',async()=>{
  const h=pairHarness();await h.settle();h.listeners.pagehide();await h.click('confirmPair');assert.equal(h.calls.length,1);
});

test('desktop Gmail continuation is fixed and never sends an already paired different person to account setup',async()=>{
  const options={protocol:'http:',hostname:'127.0.0.1',search:'?next=gmail'};
  const matching=pairHarness({...options,current:{id:'intended-profile',name:'Asha'}});await matching.settle();
  assert.equal(matching.nodes.get('pairContinue').href,'/gmail-connect.html');
  const other=pairHarness({...options,current:{id:'other-profile',name:'Sam'}});await other.settle();
  assert.equal(other.nodes.get('pairContinue').href,'/');
  assert.equal(other.nodes.get('pairExisting').hidden,false);
  assert.ok(!other.calls.some(call=>call.path==='/api/pair'));
  await other.click('switchProfile');await other.click('confirmPair');
  assert.equal(other.nodes.get('pairStart').href,'/gmail-connect.html');
  const arbitrary=pairHarness({...options,search:'?next=https://attacker.test'});await arbitrary.settle();
  assert.notEqual(arbitrary.nodes.get('pairStart')?.href,'https://attacker.test');
});

test('desktop launch always uses packaged Node utility process resources, never a PATH node command',()=>{
  const launch=utilityLaunchOptions({appPath:resolve('.'),dataDir:resolve('.work/desktop-data'),resourcesPath:resolve('desktop/resources'),environment:{NEMO_REGISTRATION_URL:'https://accounts.example.com'}});
  assert.equal(launch.modulePath,resolve('desktop/host-process.mjs'));
  assert.equal(launch.options.env.NEMO_DESKTOP_DATA_DIR,resolve('.work/desktop-data'));
  assert.equal(launch.options.serviceName,'Nemo background assistant');
  assert.equal(launch.options.stdio,'ignore');assert.deepEqual(launch.args,[]);
  assert.ok(!Object.hasOwn(launch.options.env,'ELECTRON_RUN_AS_NODE'));
});

test('only an exact ephemeral loopback bootstrap and allowlisted browser sign-in are accepted',()=>{
  const token='a'.repeat(43), parsed=parseBootstrap(`http://127.0.0.1:46791/setup/#setup=${token}`);
  assert.equal(parsed.token,token);assert.equal(parsed.pageUrl,'http://127.0.0.1:46791/setup/');assert.ok(!parsed.pageUrl.includes(token));
  for(const bad of [`https://evil.example/setup/#setup=${token}`,`http://localhost:4000/setup/#setup=${token}`,`http://127.0.0.1:4000/setup/?token=${token}`,`http://127.0.0.1:4000/pair.html#setup=${token}`]) assert.throws(()=>parseBootstrap(bad));
  assert.equal(allowedExternal('https://accounts.example.com/approve','https://accounts.example.com'),true);
  assert.equal(allowedExternal('https://accounts.example.com.evil.test/approve','https://accounts.example.com'),false);
  assert.equal(allowedExternal('file:///C:/private','https://accounts.example.com'),false);
  assert.equal(allowedExternal('https://auth.openai.com/api/accounts/authorize?state=safe',''),true);
  assert.equal(allowedExternal('https://auth.openai.com/other','https://accounts.example.com'),false);
  assert.equal(allowedExternal('https://auth.openai.com.evil.test/api/accounts/authorize',''),false);
  assert.equal(allowedExternal('https://openrouter.ai/auth?state=safe',''),false);
  assert.equal(allowedExternal(CHATGPT_USAGE_URL,''),true);
  assert.equal(allowedExternal(CHATGPT_USAGE_URL+'?next=https://evil.test',''),false);
  assert.equal(allowedExternal(CHATGPT_USAGE_URL+'#other',''),false);
  assert.equal(allowedExternal('https://chatgpt.com/other',''),false);
  assert.equal(allowedExternal('http://127.0.0.1:4000/sign-in','http://127.0.0.1:4000'),false);
});

test('desktop API forwards only named actions and authenticates the private listener',async()=>{
  const calls=[];
  const result=await setupRequest({origin:'http://127.0.0.1:4000',token:'PRIVATE',action:'owner',input:{name:'Asha'},fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({owner:{name:'Asha'}});}});
  assert.equal(result.owner.name,'Asha');assert.equal(calls[0].url,'http://127.0.0.1:4000/api/setup/owner');
  assert.equal(calls[0].options.headers.Authorization,'Bearer PRIVATE');assert.equal(calls[0].options.headers.Origin,'http://127.0.0.1:4000');assert.equal(calls[0].options.redirect,'error');
  await assert.rejects(setupRequest({origin:'http://127.0.0.1:4000',token:'PRIVATE',action:'https://evil.test'}),/setup actions/);
});

test('release sign-in configuration comes from packaged resources without parent environment setup',async t=>{
  const directory=await mkdtemp(resolve(tmpdir(),'nemo-release-settings-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(resolve(directory,'desktop-runtime'));await writeFile(resolve(directory,'desktop-runtime/manifest.json'),JSON.stringify({registrationOrigin:'https://accounts.nemo.example'}));
  assert.equal(await registrationOriginForLaunch({resourcesPath:directory,appPath:directory}),'https://accounts.nemo.example');
  assert.equal(await registrationOriginForLaunch({resourcesPath:directory,appPath:directory,environment:{NEMO_REGISTRATION_URL:'https://staging.nemo.example'}}),'https://staging.nemo.example');
  await assert.rejects(registrationOriginForLaunch({resourcesPath:directory,appPath:directory,environment:{NEMO_REGISTRATION_URL:'https://accounts.example/phishing'}}),/not configured/);
});

test('local chat opens only a fresh invitation for the trusted app origin and owner',async()=>{
  const origin='http://127.0.0.1:45321',invitation={url:origin+'/pair.html#invite=ABCD-EFGH-JKLM-NPQR',profile:{id:'owner',name:'Asha'}};
  assert.equal(localInvitationUrl(invitation,origin,'owner'),invitation.url);
  for(const url of ['https://evil.example/pair.html#invite=ABCD-EFGH-JKLM-NPQR','http://127.0.0.1:45322/pair.html#invite=ABCD-EFGH-JKLM-NPQR',origin+'/pair.html?invite=ABCD-EFGH-JKLM-NPQR',origin+'/pair.html#invite=ABCD-EFGH-JKLM-NPQR&other=1',origin+'/admin#invite=ABCD-EFGH-JKLM-NPQR'])assert.throws(()=>localInvitationUrl({...invitation,url},origin,'owner'));
  assert.throws(()=>localInvitationUrl(invitation,origin,'different-profile'));
  const calls=[],opened=[];
  const result=await openLocalSpace({origin:'http://127.0.0.1:49999',token:'CAPABILITY',async fetchImpl(url,options){calls.push({url,options});return Response.json(url.endsWith('/status')?{owner:{id:'owner'},app:{origin}}:invitation);},async openWindow(url){opened.push(url);}});
  assert.deepEqual(opened,[invitation.url]);assert.deepEqual(result,{opened:true,profile:{id:'owner',name:'Asha'}});
  assert.deepEqual(calls.map(call=>call.url),['http://127.0.0.1:49999/api/setup/status','http://127.0.0.1:49999/api/setup/local-invite']);
  assert.ok(!JSON.stringify(result).includes('invite='));assert.ok(calls.every(call=>call.options.headers.Authorization==='Bearer CAPABILITY'));
  await assert.rejects(openLocalSpace({origin:'http://127.0.0.1:49999',token:'CAPABILITY',fetchImpl:async url=>Response.json(url.endsWith('/status')?{owner:{id:'owner'},app:{origin}}:invitation),openWindow:async()=>{throw new Error(invitation.url);}}),error=>!error.message.includes('ABCD')&&error.message.includes('in this app'));
});

test('opt-in Windows startup follows the stable installed launcher across app updates',()=>{
  const executable=resolve('fixture-install/app-0.3.0/Nemo.exe'),stub=resolve('fixture-install/Nemo.exe');
  assert.deepEqual(loginItemOptions({platform:'win32',packaged:true,execPath:executable,exists:file=>file===stub}),{path:stub,args:[]});
  assert.deepEqual(loginItemOptions({platform:'win32',packaged:false,execPath:executable,exists:()=>true}),{});
  assert.deepEqual(loginItemOptions({platform:'win32',packaged:true,execPath:resolve('portable/Nemo.exe'),exists:()=>true}),{});
});

let chromium;
try { ({chromium}=createRequire(process.env.NEMO_TEST_BROWSER_PACKAGE||import.meta.url)('playwright')); } catch {}
test('unified setup, provider acknowledgement, family and optional phone controls share the desktop layout',{skip:!chromium,timeout:60_000},async t=>{
  const {startUnifiedPreview}=await import('./fixtures/desktop-unified-preview.mjs');
  const fixture=await startUnifiedPreview();let browser;
  t.after(async()=>{await browser?.close();await fixture.close();});
  browser=await chromium.launch({headless:true,...(process.env.NEMO_TEST_BROWSER_CHANNEL?{channel:process.env.NEMO_TEST_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:1040,height:780}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
  await page.goto(fixture.entry);await page.getByLabel('Your first name',{exact:true}).fill('Asha');await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Continue with ChatGPT',exact:true}).click();
  await page.getByRole('region',{name:'ChatGPT plan usage'}).waitFor();assert.equal(await page.locator('input[type=password]').count(),0);
  await page.getByRole('button',{name:'Got it',exact:true}).click();await page.getByRole('button',{name:'Continue as Asha',exact:true}).click();
  await page.getByRole('button',{name:'Open Asha’s space',exact:true}).waitFor();
  assert.equal((await(await context.request.get(fixture.origin+'/api/session')).json()).authenticated,false);
  await page.getByRole('button',{name:'Open Asha’s space',exact:true}).click();await page.getByRole('heading',{name:'Hello, Asha.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Family',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Jamie');
  await page.getByLabel('Child mode',{exact:true}).check();await page.getByRole('button',{name:'Add family member',exact:true}).click();
  await page.getByRole('heading',{name:'Invitation for Jamie',exact:true}).waitFor();assert.match(await page.locator('.family-invite-code').textContent(),/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'This PC & ChatGPT',exact:true}).click();
  await page.getByRole('button',{name:'Manage',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Not available in this preview',exact:true}).isDisabled(),true);
  assert.equal((await context.request.get(fixture.origin+'/host-setup.js')).status(),404);
  assert.equal((await context.request.get(fixture.origin+'/host-setup.css')).status(),404);
  assert.deepEqual(errors,[]);
});

test('desktop personal invitations require an explicit identity switch and members do not see home controls',{skip:!chromium,timeout:60_000},async t=>{
  const {startUnifiedPreview}=await import('./fixtures/desktop-unified-preview.mjs');
  const fixture=await startUnifiedPreview();let browser;t.after(async()=>{await browser?.close();await fixture.close();});
  const owner=await fixture.app.profiles.owner();await fixture.app.profiles.rename(owner.id,'Asha');const invite=await fixture.app.profiles.invite(owner.id);
  browser=await chromium.launch({headless:true,...(process.env.NEMO_TEST_BROWSER_CHANNEL?{channel:process.env.NEMO_TEST_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:1040,height:780}}),page=await context.newPage();
  await page.goto(fixture.origin+'/desktop.html#invite='+invite.code);await page.getByRole('button',{name:'Open Asha’s space',exact:true}).click();
  await page.getByRole('heading',{name:'Hello, Asha.',exact:true}).waitFor();
  const member=await fixture.app.profiles.create('Sam',false),other=await fixture.app.profiles.invite(member.id);
  await page.goto(fixture.origin+'/desktop.html#invite='+other.code);await page.getByRole('button',{name:'Sign out Asha',exact:true}).waitFor();
  assert.equal((await fixture.app.profiles.previewInvite(other.code)).profile.id,member.id);
  await page.getByRole('button',{name:'Sign out Asha',exact:true}).click();
  assert.equal((await(await context.request.get(fixture.origin+'/api/session')).json()).authenticated,false);
  assert.equal((await fixture.app.profiles.previewInvite(other.code)).profile.id,member.id);
  await page.getByRole('button',{name:'Open Sam’s space',exact:true}).click();await page.getByRole('heading',{name:'Hello, Sam.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).click();assert.equal(await page.getByRole('button',{name:'This PC & ChatGPT',exact:true}).count(),0);
  await page.getByRole('button',{name:'My devices',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Add family member',exact:true}).count(),0);
  for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
});

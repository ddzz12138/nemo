import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFamilyServer} from '../lib/family-server.mjs';
import {createPreviewMemory} from './helpers/preview-memory.mjs';

let chromium;try{({chromium}=createRequire(process.env.NEMO_TEST_BROWSER_PACKAGE||import.meta.url)('playwright'));}catch{}
async function fixture(t,{memory=true}={}){
  const prefix=fileURLToPath(new URL('./.tmp-navigation-',import.meta.url)),dataDir=await mkdtemp(prefix);
  let calls=0;
  const app=await createFamilyServer({dataDir,ownerName:'Dan',memoryFactory:memory?createPreviewMemory:undefined,publicDir:fileURLToPath(new URL('../public',import.meta.url)),logger(){},provider:{status:()=>({connected:true,verified:true}),async run(){calls++;return{text:calls===1?'Two things from school:\n\n- Return the trip form by **Friday**.\n- Pack the PE kit for **Monday**.\n\nJust the actions. The way you like it.':calls===2?'<img src=x onerror="window.nemoInjected=true">\n\n**Literal HTML stays text.**':'A'.repeat(64001)+' **plain-text tail**',sessionId:'synthetic-layout'};}}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base='http://localhost:'+app.server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.NEMO_TEST_BROWSER_CHANNEL?{channel:process.env.NEMO_TEST_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const owner=await app.profiles.owner();
  async function pair(profile){const invite=await app.profiles.invite(profile.id);const result=await context.request.post(base+'/api/pair',{headers:{'X-Nemo-Request':'1'},data:{code:invite.code}});assert.equal(result.status(),200);}
  await pair(owner);
  t.after(async()=>{await browser.close();await app.close();assert.equal(dirname(resolve(dataDir)),dirname(resolve(prefix)));assert.ok(dataDir.startsWith(prefix));await rm(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  async function screenshot(name){if(!process.env.NEMO_BROWSER_EVIDENCE_DIR)return;const directory=resolve(process.env.NEMO_BROWSER_EVIDENCE_DIR);await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png'),fullPage:true});}
  return{app,base,context,page,errors,pair,owner,screenshot};
}

test('reference chat bubbles keep messages literal and navigation/settings reachable on phones',{skip:!chromium,timeout:60000},async t=>{
  const f=await fixture(t),{page}=f;
  await page.goto(f.base+'/');
  await page.waitForFunction(()=>!document.getElementById('messageInput').disabled);
  await page.locator('#messageInput').fill('School update?');await page.locator('#sendButton').click();
  await page.locator('.message[data-role="assistant"] strong').filter({hasText:'Friday'}).waitFor();
  const user=page.locator('.message[data-role="user"] .message-content').first(),reply=page.locator('.message[data-role="assistant"] .message-content').first();
  assert.equal(await user.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(248, 128, 9)');
  assert.equal(await reply.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 240, 228)');
  const theme=await page.evaluate(()=>({paper:getComputedStyle(document.body).backgroundColor,wash:getComputedStyle(document.body).backgroundImage}));
  assert.equal(theme.paper,'rgb(255, 250, 244)');assert.match(theme.wash,/linear-gradient\((?:180deg,\s*)?rgb\(230, 205, 185\)/);
  assert.equal(await reply.locator('li').count(),2);
  assert.equal(await page.locator('.nemo-header').getByRole('link',{name:'Nemo chat'}).textContent(),'nemo');
  assert.equal(await page.getByRole('button',{name:'Profile and settings'}).textContent(),'Dan');
  await f.screenshot('nemo-reference-chat-phone');
  for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'chat overflow at '+width);
    const box=await page.locator('#sendButton').boundingBox();assert.ok(box.width>=44&&box.height>=44);
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Open menu',exact:true}).click();
  await page.locator('#nemoMenu').getByRole('button',{name:'Connected accounts',exact:true}).click();
  assert.equal(await page.locator('#nemoMenu').evaluate(node=>node.open),false);
  await page.locator('#integrationsDialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('nemo-menu-button'));
  await page.getByRole('button',{name:'Profile and settings'}).click();
  await f.screenshot('nemo-reference-profile-settings');
  await page.locator('#nemoProfile #connectionButton').click();
  await page.locator('#connectionDialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#nemoProfile').evaluate(node=>node.open),false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('nemo-profile-button'));
  await page.locator('#messageInput').fill('Keep HTML literal');await page.locator('#sendButton').click();
  await page.locator('.message-content').filter({hasText:'Literal HTML stays text.'}).waitFor();
  assert.equal(await page.locator('#messages img, #messages script').count(),0);
  assert.equal(await page.evaluate(()=>window.nemoInjected),undefined);
  await page.locator('#messageInput').fill('A long answer');await page.locator('#sendButton').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.message-content')].some(node=>node.textContent.endsWith(' **plain-text tail**')));
  const long=page.locator('.message[data-role="assistant"] .message-content').last();
  assert.equal((await long.textContent()).length,64021);
  assert.equal(await long.locator('strong').count(),0,'large replies keep the complete plain-text path');
  assert.deepEqual(f.errors,[]);
});

test('shared header preserves destinations, account deep links and identity across app pages',{skip:!chromium,timeout:90000},async t=>{
  const f=await fixture(t),{page}=f;
  for(const path of ['/history.html','/memory.html','/family.html','/family-review.html','/tasks.html','/leave.html','/tools.html','/gmail-connect.html','/passkeys.html','/setup.html','/calendar-setup.html','/native-chat.html','/sign-in.html','/pair.html']){
    await page.goto(f.base+path);
    await page.waitForFunction(()=>document.querySelector('.nemo-profile-button [data-profile-name]')?.textContent==='Dan');
    assert.equal(await page.locator('.nemo-header').count(),1,path);
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    for(const label of ['Chat','History','Memory','Tasks','Reminders','Tools & setup help'])assert.equal(await page.locator('#nemoMenu').getByRole('link',{name:label,exact:true}).isVisible(),true,path+' '+label);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,path);
    const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(node=>node.id);return ids.filter((id,index)=>ids.indexOf(id)!==index);});assert.deepEqual(duplicates,[],path);
  }
  await page.goto(f.base+'/history.html');
  await page.getByRole('button',{name:'Open menu',exact:true}).click();
  await page.locator('#nemoMenu').getByRole('link',{name:'Connected accounts',exact:true}).click();
  try { await page.locator('#integrationsDialog').waitFor({state:'visible',timeout:10000}); }
  catch(error){await f.screenshot('nemo-deeplink-failure');console.log(JSON.stringify(await page.evaluate(()=>({url:location.href,notice:document.getElementById('noticeText')?.textContent,profile:window.NemoIdentity?.profile?.name,accountsDisabled:document.getElementById('integrationsButton')?.disabled,dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.id)}))));console.log(f.errors);throw error;}
  assert.equal(new URL(page.url()).hash,'');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await f.screenshot('nemo-reference-menu');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.locator('#nemoMenu').getByRole('link',{name:'Memory',exact:true}).click();
  await page.locator('#memory-summary').getByText('You prefer short answers with the actions first.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'+ Add',exact:true}).click();await page.locator('#memory-editor-text').fill('Owner-only sample memory.');await page.getByRole('button',{name:'Save memory',exact:true}).click();
  await page.getByRole('button',{name:'Edit memory: Owner-only sample memory.',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Edit memory: Owner-only sample memory.',exact:true}).waitFor();await f.screenshot('nemo-warm-memory');
  const logout=await f.context.request.post(f.base+'/api/logout',{headers:{'X-Nemo-Request':'1','X-Nemo-Profile':f.owner.id},data:{}});assert.equal(logout.status(),200);
  const other=await f.app.profiles.create('Alex',false);await f.pair(other);await page.goto(f.base+'/history.html');
  await page.waitForFunction(()=>document.querySelector('.nemo-profile-button [data-profile-name]')?.textContent==='Alex');
  await page.getByRole('button',{name:'Profile and settings'}).click();
  assert.equal(await page.locator('#nemoProfile .nemo-profile-name').textContent(),'Alex');
  assert.ok(!(await page.locator('#nemoProfile').textContent()).includes('Dan'));
  await page.keyboard.press('Escape');await page.goto(f.base+'/memory.html');await page.locator('#memory-summary-meta').filter({hasText:'Drawn from'}).waitFor();assert.equal(await page.getByRole('button',{name:'Edit memory: Owner-only sample memory.',exact:true}).count(),0);
  assert.deepEqual(f.errors,[]);
});

test('Memory keeps its own destination and explains an unavailable engine instead of opening History',{skip:!chromium,timeout:60000},async t=>{
  const f=await fixture(t,{memory:false}),{page}=f;await page.goto(f.base+'/');
  await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.locator('#nemoMenu').getByRole('link',{name:'Memory',exact:true}).click();
  await page.locator('#memory-message').filter({hasText:'Saved memory is not connected'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/memory.html');assert.equal(await page.getByRole('button',{name:'+ Add',exact:true}).isEnabled(),false);assert.deepEqual(f.errors,[]);
});

// Synthetic phone-browser verification. No real providers or connected data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { once } from 'node:events';
import { APP_ROOT } from '../lib/config.mjs';
import { createNemoServer } from '../server.mjs';
import { createNativeChat } from '../lib/native-chat.mjs';
import { nativeFake } from './helpers/native-fake.mjs';
const require=createRequire(process.env.NEMO_TEST_PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=await mkdtemp(join(APP_ROOT,'test','.tmp-native-browser-')),evidence=join(APP_ROOT,'.work','native-ui');await mkdir(evidence,{recursive:true});
let app,browser,held=false,release;
const gate=new Promise(resolve=>release=resolve),fake=nativeFake({beforeReply:async()=>{if(held)await gate;}});
try{
  app=await createNemoServer({dataDir:root,memoryFactory:null,logger(){},provider:{status:()=>({connected:true}),async run(){throw new Error('Main chat must not run in this fixture');}},nativeFactory:options=>createNativeChat({...options,...fake,sourceRoot:resolve('synthetic'),apiMode:'chat_completions'})});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const a=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),b=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const profiles=[await app.profiles.owner(),await app.profiles.create('Synthetic second person')];
  async function pair(context,profile){const invite=await app.profiles.invite(profile.id);const response=await context.request.post(base+'/api/pair',{headers:{'X-Nemo-Request':'1'},data:{code:invite.code,deviceName:'Synthetic phone'}});assert.equal(response.status(),200);}
  await pair(a,profiles[0]);await pair(b,profiles[1]);
  const page=await a.newPage(),other=await b.newPage(),errors=[];for(const p of[page,other])p.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/native-chat.html');await page.getByLabel('Message Nemo').fill('SYNTHETIC_PRIVATE_AMBER');await page.getByRole('button',{name:'Send ↗'}).click();await page.getByText('Complete',{exact:true}).waitFor();
  assert.equal(fake.prompts,1);await page.reload();await page.getByText('Complete',{exact:true}).waitFor();assert.equal(fake.prompts,1);
  for(const width of[320,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'chat-preview-phone.png'),fullPage:true});
  await a.setOffline(true);await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor({timeout:10_000});await a.setOffline(false);await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.getByLabel('Message Nemo').waitFor({state:'visible'});assert.equal(fake.prompts,1);
  await other.goto(base+'/native-chat.html');await other.getByLabel('Message Nemo').fill('SYNTHETIC_PRIVATE_BLUE');await other.getByRole('button',{name:'Send ↗'}).click();await other.getByText('Complete',{exact:true}).waitFor();assert.ok(!(await other.locator('body').innerText()).includes('SYNTHETIC_PRIVATE_AMBER'));
  held=true;await page.getByLabel('Message Nemo').fill('Synthetic stoppable task');await page.getByRole('button',{name:'Send ↗'}).click();await page.getByRole('button',{name:'Stop',exact:true}).click();await page.getByText('Stopped. This message will not be sent again automatically.',{exact:true}).waitFor();release();
  const logout=await a.request.post(base+'/api/logout',{headers:{'X-Nemo-Request':'1','X-Nemo-Profile':profiles[0].id},data:{}});assert.equal(logout.status(),200);await pair(a,profiles[1]);await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor({timeout:10_000});assert.equal(await page.locator('#previewMessages').innerText(),'');
  await page.reload();await page.getByText('Complete',{exact:true}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('SYNTHETIC_PRIVATE_AMBER'));assert.equal(fake.prompts,3);assert.deepEqual(errors,[]);
  const result={ok:true,syntheticOnly:true,profiles:2,reloadNoResubmit:true,offlineReconnect:true,stop:true,staleProfileCleared:true,widths:[320,390,768],jsErrors:0};await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{release();await browser?.close();await app?.close();if(dirname(resolve(root))!==resolve(APP_ROOT,'test')||!root.startsWith(join(APP_ROOT,'test','.tmp-native-browser-')))throw new Error('Unexpected fixture path');await rm(root,{recursive:true,force:true});}

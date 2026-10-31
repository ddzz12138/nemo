// Synthetic browser fixture: no account data, real tool calls or inference.
import {createRequire} from 'node:module';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve,dirname} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createNemoServer} from '../server.mjs';
const require=createRequire(process.env.NEMO_TEST_BROWSER_PACKAGE || import.meta.url);
const {chromium}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));const fixture=await mkdtemp(join(root,'test/.tmp-activity-browser-'));const evidence=join(root,'evidence');await mkdir(evidence,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const memories=[];let app,browser;
try{
 app=await createNemoServer({dataDir:fixture,publicDir:join(root,'public'),ownerName:'Test Owner',logger(){},provider:{status:()=>({connected:true}),async run({onActivity,onText}){
  onActivity({kind:'thinking',verb:'mulling'});await sleep(1800);
  onActivity({kind:'tool',name:'mcp__nemo__gmail_search',key:'fixture',state:'running',input:'SECRET_TOOL'});await sleep(1300);
  onActivity({kind:'tool',name:'mcp__nemo__gmail_search',key:'fixture',state:'completed',output:'SECRET_TOOL'});onText('Your synthetic response is ready.');return{text:'Your synthetic response is ready.',sessionId:'fixture'};
 }},memoryFactory:async()=>({engine:{connected:true},mirror:{status:()=>({sources:{}})},controller:{},curation:{capture({onActivity}){onActivity({kind:'memory',phase:'queued'});onActivity({kind:'memory',phase:'reviewing'});memories.push(onActivity);}}})});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const invite=await app.profiles.invite((await app.profiles.owner()).id);const pair=await context.request.post(base+'/api/pair',{headers:{'Content-Type':'application/json','X-Nemo-Request':'1'},data:{code:invite.code,deviceName:'Synthetic browser'}});assert.equal(pair.status(),200);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('#messageInput').waitFor({state:'visible'});
 await page.locator('#messageInput').fill('Please test the first activity log.');await page.locator('#sendButton').click();await page.getByText('Mulling…',{exact:true}).first().waitFor();
 await page.locator('.activity-log summary').first().click();await page.getByText('Searching Gmail…',{exact:true}).first().waitFor();await page.getByText('Reviewing memories locally…',{exact:true}).first().waitFor();
 await page.waitForFunction(()=>!document.getElementById('messageInput').disabled);
 await page.reload();await page.getByText('Reviewing memories locally…',{exact:true}).first().waitFor();assert.equal(await page.locator('.activity-log[open]').count(),0);
 await page.locator('#messageInput').fill('Please test a second response while memory is busy.');await page.locator('#sendButton').click();await page.waitForFunction(()=>document.querySelectorAll('.activity-log').length===2);
 await page.waitForFunction(()=>document.querySelectorAll('.message[data-role="assistant"] .activity-log[data-pending="true"]').length===2);
 for(let n=0;n<100&&memories.length<2;n++)await sleep(80);assert.equal(memories.length,2);
 await context.setOffline(true);memories[0]({kind:'memory',phase:'saved',added:1,updated:0});memories[1]({kind:'memory',phase:'unchanged'});await sleep(1300);await context.setOffline(false);
 await page.waitForFunction(()=>document.querySelectorAll('.activity-log[data-pending="false"]').length===2,{},{timeout:15000});
 await page.waitForFunction(()=>document.querySelectorAll('.activity-log').length===2&&document.getElementById('runStatus').hidden&&document.getElementById('notice').hidden);
 assert.equal((await page.locator('body').innerText()).includes('SECRET_TOOL'),false);
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(evidence,'activity-phone.png'),fullPage:true});
 await page.locator('.activity-log summary').first().click();await page.getByText('1 memory saved',{exact:true}).waitFor();await page.screenshot({path:join(evidence,'activity-expanded.png'),fullPage:true});
 await page.goto(base+'/history.html');await page.getByRole('button',{name:'View conversation'}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.activity-log').length===2);assert.equal(await page.locator('.activity-log[open]').count(),0);
 assert.deepEqual(errors,[]);const result={ok:true,syntheticOnly:true,waitingWord:true,toolTimeline:true,postReplyMemory:true,secondMessageWhileReviewing:true,reloadRecovery:true,offlineRecovery:true,history:true,widths:[320,390,768],jsErrors:0};await writeFile(join(evidence,'activity-browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await app?.close();if(dirname(resolve(fixture))!==resolve(root,'test')||!fixture.startsWith(join(root,'test','.tmp-activity-browser-')))throw Error('Unexpected fixture path');await rm(fixture,{recursive:true,force:true});}

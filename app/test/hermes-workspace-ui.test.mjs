import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createProfileStore} from '../lib/profile-store.mjs';
import {createHermesWorkspace} from '../lib/hermes-workspace.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const require=createRequire(import.meta.url),interfaceRequire=createRequire(new URL('../desktop/interface/package.json',import.meta.url));
let chromium;try{({chromium}=require('playwright'));}catch{}

test('compiled Hermes workspace shows actual readiness, native approval choices and private masked request controls',{skip:!chromium,timeout:45000},async t=>{
  const directory=await mkdtemp(resolve('test/.tmp-hermes-workspace-ui-'));
  const profiles=await createProfileStore({dataDir:directory,ownerName:'Synthetic workspace owner'}),owner=await profiles.owner(),calls=[];
  let client;
  const workspace=await createHermesWorkspace({dataDir:directory,profileId:owner.id,getProfile:id=>profiles.profile(id),isAuthorized:async()=>true,
    pythonPath:resolve('synthetic-python.exe'),sourceRoot:resolve('synthetic-hermes'),chatgptSession:async()=>({provider:'chatgpt',model:'synthetic'}),
    prepareTools:async({signal,onProgress})=>{onProgress({package:'chromium',stage:'download',done:50,total:100});await delay(150,null,{signal});return{ok:true,tools:{browser:{available:true},computer:{available:true}}};},
    createBroker:async()=>({baseUrl:'http://127.0.0.1:12345/v1',capability:'SYNTHETIC',model:'synthetic',async close(){}}),
    startWorker:async()=>{
      client=new EventEmitter();
      const emitRequest=(id,method,params)=>client.emit('request',{id,method,params:{session_id:'workspace-live',...params}});
      client.request=async(method,params)=>{
        if(['session.create','session.resume'].includes(method))return {session_id:'workspace-live',stored_session_id:'workspace-stored',messages:[],info:{tools:{terminal:['terminal']},skills:{native:['test-skill']}}};
        if(method==='prompt.submit')setImmediate(()=>emitRequest('approval','approval',{command:'echo <script>UNTRUSTED_NATIVE_COMMAND</script>',description:'Native action requires a decision.',choices:['once','session','always','deny']}));
        return {status:'streaming'};
      };
      client.answer=(id,result)=>setImmediate(()=>{
        if(id==='approval')emitRequest('secret','secret',{env_var:'SYNTHETIC_TOKEN',prompt:'Enter the test service token'});
        else if(id==='secret')emitRequest('clarify','clarify',{questions:[{qid:'topic',question:'Which topic?',choices:['School','Outing']}]});
        else {client.emit('event',{type:'tool.start',session_id:'workspace-live',payload:{name:'terminal',state:'completed'}});client.emit('event',{type:'subagent.started',session_id:'workspace-live',payload:{name:'Native helper'}});client.emit('event',{type:'message.complete',session_id:'workspace-live',payload:{text:'Completed with upstream controls.',status:'complete'}});}
      });
      return {client,async close(){client.emit('disconnected');}};
    }});
  t.after(async()=>{await workspace.close();assert.equal(dirname(directory),resolve('test'));assert.match(directory,/\.tmp-hermes-workspace-ui-/);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const {build}=interfaceRequire('esbuild');
  const component=resolve('desktop/interface/src/HermesWorkspacePage.jsx');
  const bundle=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {HermesWorkspacePage} from ${JSON.stringify(component)};
async function request(method,input){const response=await fetch('/api/hermes-workspace/'+method,{method:method==='status'?'GET':'POST',headers:{'content-type':'application/json'},...(method==='status'?{}:{body:JSON.stringify(input||{})})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;}
const api={hermesWorkspaceStatus:()=>request('status'),hermesWorkspacePrepare:()=>request('prepare'),hermesWorkspaceStart:()=>request('start'),hermesWorkspacePrompt:input=>request('prompt',input),hermesWorkspaceRespond:input=>request('respond',input),hermesWorkspaceStop:()=>request('stop')};
createRoot(document.getElementById('root')).render(<HermesWorkspacePage api={api} session={{profile:${JSON.stringify(owner)}}}/>);
`,resolveDir:resolve('desktop/interface'),loader:'jsx'},bundle:true,write:false,outdir:'synthetic-ui',format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents;
  const css=await readFile(resolve('desktop/interface/src/hermes-workspace.css'));
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/api/hermes-workspace/')){
      try{const method=req.url.slice('/api/hermes-workspace/'.length);if(!['status','prepare','start','prompt','respond','stop'].includes(method))throw Object.assign(new Error('Not found'),{status:404});let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):undefined;calls.push({method,input});const result=await workspace[method](input);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}
      catch(error){res.writeHead(error.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}return;
    }
    if(req.url==='/ui.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(js);return;}
    if(req.url==='/ui.css'){res.writeHead(200,{'content-type':'text/css'});res.end(css);return;}
    if(req.url!=='/'){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:16px;background:#fffaf4}button,input,textarea,select{font:inherit}button{cursor:pointer}#root{max-width:880px;margin:auto}</style></head><body><div id="root"></div><script src="/ui.js"></script></body></html>');
  });server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  let browser;t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));});
  browser=await chromium.launch({headless:true,channel:process.env.NEMO_TEST_BROWSER_CHANNEL||'chrome'});const context=await browser.newContext({viewport:{width:1280,height:900}});await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
  await page.getByRole('button',{name:'Prepare browser and computer tools',exact:true}).click();
  await page.getByText('Hermes is preparing its browser and computer tools.',{exact:true}).waitFor();
  await page.getByText('Browser and computer software is prepared.',{exact:true}).waitFor();assert.equal(calls.some(call=>call.method==='start'||call.method==='prompt'),false);
  await page.getByRole('button',{name:'Open Hermes workspace',exact:true}).click();
  await page.getByText('Stop Hermes to return to regular chat or edit Memory.',{exact:false}).waitFor();
  await page.getByText('Skills and tools reported by Hermes',{exact:true}).click();assert.equal(await page.getByText('test-skill',{exact:true}).isVisible(),true);
  await page.getByRole('textbox',{name:'Message Hermes',exact:true}).fill('Use a native tool.');await page.getByRole('button',{name:'Send to Hermes',exact:true}).click();
  await page.getByRole('region',{name:'Hermes approval'}).waitFor();
  for(const label of ['Allow once','Allow for this session','Always allow','Deny'])assert.equal(await page.getByRole('button',{name:label,exact:true}).isVisible(),true);
  assert.equal(await page.locator('script').count(),1,'native command is rendered as text, not executable markup');
  await page.getByRole('button',{name:'Allow once',exact:true}).focus();await page.keyboard.press('Enter');
  const secret=page.getByLabel('Enter the test service token',{exact:false});await secret.fill('SYNTHETIC_SECRET_VALUE');assert.equal(await secret.getAttribute('type'),'password');
  await page.getByRole('button',{name:'Send answer',exact:true}).click();await page.getByRole('combobox',{name:'Which topic?',exact:true}).selectOption('School');await page.getByRole('button',{name:'Send answer',exact:true}).click();
  await page.getByText('Completed with upstream controls.',{exact:true}).waitFor();assert.equal((await page.locator('body').innerText()).includes('SYNTHETIC_SECRET_VALUE'),false);
  assert.deepEqual(calls.filter(call=>call.method==='respond').map(call=>call.input.id),['approval','secret','clarify']);
  await page.getByText('Tool and agent activity',{exact:true}).click();assert.equal(await page.getByText('Native helper',{exact:true}).isVisible(),true);
  for(const width of [320,768,1024,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'workspace overflow at '+width);}
  await page.getByRole('button',{name:'Stop Hermes',exact:true}).click();await page.getByRole('button',{name:'Open Hermes workspace',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Message Hermes',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);
});

// Explicit functional diagnostic, never a health check. Uses the host's already
// selected provider for two synthetic prompts; no source connections are read.
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_ROOT } from '../lib/config.mjs';
import { createNativeChat } from '../lib/native-chat.mjs';
import { createHermesForwarder } from '../lib/hermes-forwarder.mjs';

const pythonPath=process.env.NEMO_TEST_HERMES_PYTHON,sourceRoot=process.env.NEMO_TEST_HERMES_SOURCE,hermesHome=process.env.NEMO_TEST_HOST_HOME;
const apiMode=process.env.NEMO_TEST_NATIVE_MODE||'codex_responses';
if(!pythonPath||!sourceRoot||!hermesHome)throw new Error('Supply explicit host runtime paths for this functional check.');
const work=join(APP_ROOT,'.work');await mkdir(work,{recursive:true});const dataDir=await mkdtemp(join(work,'native-host-provider-'));
const profiles=[{id:randomUUID(),role:'owner'},{id:randomUUID(),role:'member',classification:'adult'}];
const markers=profiles.map(()=>`SYNTHETIC_${randomUUID().replaceAll('-','').toUpperCase()}`),calls=[];
const host=createHermesForwarder({pythonPath,sourceRoot,hermesHome});let chat;
let result={ok:false,provider:'existing-host-provider',connectedAccountReads:0,tools:0};
try{
  chat=await createNativeChat({dataDir,pythonPath,sourceRoot,hermesHome,apiMode,getProfile:id=>profiles.find(profile=>profile.id===id),isDeviceActive:async device=>device==='synthetic-test',forward:async input=>{
    const response=await host(input);const info={profile:profiles.findIndex(profile=>profile.id===input.profileId),method:input.method,path:input.path,status:response.status};if(response.status!==200)info.reason=(await response.clone().json()).reason;calls.push(info);return response;
  }});
  const tasks=await Promise.all(profiles.map((profile,index)=>chat.submit(profile.id,{requestKey:randomUUID(),deviceId:'synthetic-test',message:`This is an isolated Nemo integration test. Reply with exactly ${markers[index]} and no other text. Do not call any tools.`})));
  const deadline=Date.now()+180_000;
  const outputs=await Promise.all(tasks.map(async({task},index)=>{
    while(Date.now()<deadline){const current=(await chat.get(profiles[index].id,task.id)).task;if(current.phase==='complete')return current;if(!['queued','running'].includes(current.phase))throw new Error('A native synthetic turn paused before completion.');await delay(250);}
    throw new Error('The native functional check timed out; no prompt was resubmitted.');
  }));
  if(outputs.some((output,index)=>!output.text.includes(markers[index])||output.text.includes(markers[1-index])))throw new Error('Native synthetic profile answers did not match.');
  result={...result,ok:true,profiles:2,privateReplies:true,realHermesEngine:true,providerRequests:calls.filter(call=>call.method==='POST').length,realModelCalls:2};
}catch(error){result={...result,error:error.message,calls};process.exitCode=1;}
finally{await chat?.close();if(dirname(resolve(dataDir))!==resolve(work)||!dataDir.startsWith(join(work,'native-host-provider-')))throw new Error('Unexpected diagnostic directory.');await rm(dataDir,{recursive:true,force:true});await writeFile(join(work,'native-host-provider-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeChat} from '../lib/native-chat.mjs';
import {connectionTools} from '../lib/connections.mjs';
const pythonPath=process.env.NEMO_TEST_NATIVE_PYTHON,sourceRoot=process.env.NEMO_TEST_NATIVE_SOURCE;
const key=value=>createHash('sha256').update(value).digest('hex');
const jsonStream=value=>new Response(value.map(item=>'data: '+JSON.stringify(item)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
function completion(input,text,call){
  const base={id:'synthetic-'+randomUUID(),object:'chat.completion.chunk',created:1,model:'synthetic-model'};
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{role:'assistant',content:text};
  return jsonStream([{...base,choices:[{index:0,delta,finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}]);
}
async function finish(chat,profileId,id){for(let i=0;i<900;i++){const {task}=await chat.get(profileId,id);if(!['queued','running'].includes(task.phase))return task;await delay(50);}throw new Error('Synthetic native tool answer timed out.');}

test('installed native Hermes calls the profile-scoped read relay and retains safe tool Activity',{skip:!pythonPath||!sourceRoot,timeout:90_000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nemo-native-tools-')),a={id:randomUUID(),role:'owner'},b={id:randomUUID(),role:'member',classification:'adult'},profiles=new Map([[a.id,a],[b.id,b]]),toolReads=[],requests=[];
  let plain=false;
  const chat=await createNativeChat({dataDir,getProfile:id=>profiles.get(id),isDeviceActive:async()=>true,pythonPath,sourceRoot,apiMode:'chat_completions',
    connectionsForProfile:async id=>({key:key(id+plain),tools:plain?[]:connectionTools,async execute(name,args){toolReads.push({profileId:id,name,args});return{connected:true,items:[{id:'gbrain:nemo-notes/favorite',excerpt:id===a.id?'SYNTHETIC_AMBER_FACT':'SYNTHETIC_BLUE_FACT'}]};}}),
    forward:async input=>{
      if(input.path==='/v1/models')return Response.json({data:[{id:'synthetic-model'}]});requests.push({profileId:input.profileId,body:input.body});
      const result=input.body.messages.filter(message=>message.role==='tool').at(-1);
      if(result)return completion(input,'Synthetic answer: '+result.content);
      if(input.body.tools?.some(tool=>tool.function?.name==='mcp__nemo__memory_search'))return completion(input,null,{name:'mcp__nemo__memory_search',arguments:{query:'favorite colour',source:'notes'}});
      return completion(input,'SYNTHETIC_PLAIN_ANSWER');
    }
  });t.after(async()=>{await chat.close();await rm(dataDir,{recursive:true,force:true});});
  const run=async profile=>{const submitted=await chat.submit(profile.id,{message:'Synthetic question about my saved preference.',requestKey:randomUUID(),deviceId:'synthetic-device'});return finish(chat,profile.id,submitted.task.id);};
  const first=await run(a);assert.equal(first.phase,'complete',JSON.stringify(first));assert.match(first.text,/SYNTHETIC_AMBER_FACT/);assert.ok(!first.text.includes('SYNTHETIC_BLUE_FACT'));assert.equal(first.tools,1);assert.ok(first.activity.entries.some(entry=>entry.label==='Memory search complete'));
  const second=await run(b);assert.equal(second.phase,'complete',JSON.stringify(second));assert.match(second.text,/SYNTHETIC_BLUE_FACT/);assert.ok(!second.text.includes('SYNTHETIC_AMBER_FACT'));
  assert.deepEqual(toolReads.map(read=>read.profileId),[a.id,b.id]);assert.ok(toolReads.every(read=>Object.keys(read.args).every(key=>['query','source'].includes(key))));
  plain=true;const third=await run(a);assert.equal(third.phase,'complete');assert.equal(third.tools,0);assert.equal(third.text,'SYNTHETIC_PLAIN_ANSWER');
  const plainRequest=requests.at(-1);assert.ok(!JSON.stringify(plainRequest.body).includes('SYNTHETIC_AMBER_FACT'),'removing consent must not resume a session containing source results');
  assert.ok(!(await chat.list(b.id)).tasks.some(task=>task.text.includes('SYNTHETIC_AMBER_FACT')));
});

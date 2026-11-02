import test from 'node:test';
import assert from 'node:assert/strict';
import {toPlanRequest,toHermesCompletion,createChatGPTPlanBroker} from '../lib/chatgpt-plan-broker.mjs';

const tool = name => ({type:'function',function:{name,description:'Upstream Hermes '+name,parameters:{type:'object',properties:{instruction:{type:'string'}},required:['instruction'],additionalProperties:false}}});
const native = {nativeTools:true};
test('native workspace preserves upstream schemas without expanding family tools',()=>{
  const request={messages:[{role:'user',content:'Use a skill'}],tools:['skills_list','skill_view','browser_navigate','terminal','delegate_task'].map(tool),parallel_tool_calls:true};
  assert.throws(()=>toPlanRequest(request,'synthetic-model'));
  const result=toPlanRequest(request,'synthetic-model',[],native);
  assert.deepEqual(result.tools[0].tools.map(t=>t.parameters),request.tools.map(t=>t.function.parameters));
  assert.deepEqual(result.tools[0].tools.map(t=>t.name),request.tools.map(t=>t.function.name));
  assert.equal(result.parallel_tool_calls,true);
  assert.equal(result.store,false);
  assert.throws(()=>toPlanRequest({...request,tools:[tool('bad name')]},'synthetic-model',[],native));
  assert.throws(()=>toPlanRequest({...request,tools:[tool('terminal'),tool('terminal')]},'synthetic-model',[],native));
});
test('native screenshots survive translation and default family route rejects them',()=>{
  const request={messages:[{role:'user',content:[{type:'text',text:'Look at this screen'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj',detail:'high'}}]}],tools:[tool('computer')]};
  assert.throws(()=>toPlanRequest(request,'synthetic-model'));
  assert.deepEqual(toPlanRequest(request,'synthetic-model',[],native).input[0].content,[{type:'input_text',text:'Look at this screen'},{type:'input_image',image_url:'data:image/png;base64,c3ludGhldGlj',detail:'high'}]);
  request.messages[0].content[1].image_url.url='file:///private.png';
  assert.throws(()=>toPlanRequest(request,'synthetic-model',[],native));
});
test('native completion accepts only tools offered in that provider request',()=>{
  const response={output:[{type:'function_call',name:'terminal',call_id:'upstream-call',arguments:JSON.stringify({instruction:'x'.repeat(5000)})}]};
  assert.equal(toHermesCompletion(response,['terminal'],native).choices[0].message.tool_calls[0].function.name,'terminal');
  assert.throws(()=>toHermesCompletion(response,[],native));
  assert.throws(()=>toHermesCompletion(response,['terminal']));
});
test('native historic calls remain readable after upstream changes its active tool catalog',()=>{
  const request={messages:[{role:'assistant',content:null,tool_calls:[{id:'previous',type:'function',function:{name:'browser_navigate',arguments:'{}'}}]},{role:'tool',tool_call_id:'previous',content:'Page read.'},{role:'user',content:'Now use a skill.'}],tools:[tool('skill_view')]};
  const result=toPlanRequest(request,'synthetic-model',[],native);
  assert.equal(result.input[0].name,'browser_navigate');
  assert.equal(result.tools[0].tools[0].name,'skill_view');
});
test('native broker rechecks authorization and never gives the worker the account credential',async t=>{
  let authorized=true,calls=0;
  const token='SYNTHETIC_CHATGPT_TOKEN_NEVER_A_REAL_ACCOUNT';
  const broker=await createChatGPTPlanBroker({nativeTools:true,session:{provider:'chatgpt',accessToken:token,model:'synthetic-model'},authorize:async()=>authorized,fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(JSON.parse(options.body).tools[0].tools[0].name,'skills_list');
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Synthetic workspace reply.'}]}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  t.after(()=>broker.close());
  assert.notEqual(broker.capability,token);
  const send=()=>fetch(broker.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+broker.capability,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'List skills'}],tools:[tool('skills_list')]})});
  assert.equal((await send()).status,200);assert.equal(calls,1);
  authorized=false;assert.equal((await send()).status,503);assert.equal(calls,1);
});

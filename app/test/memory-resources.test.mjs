import test from 'node:test';import assert from 'node:assert/strict';
import {createExecutionSlots} from '../lib/execution-slots.mjs';
import {scheduleMemoryProcessing} from '../lib/memory-resources.mjs';
test('profile learning and indexing share one GPU slot while foreground searches take priority',async()=>{
  const resources=createExecutionSlots(),release=await resources.acquire({kind:'gpu'}),order=[];
  const a={async search(){order.push('search-A');return'A';}},b={async indexPending(){order.push('index-B');}};
  const reviewer=scheduleMemoryProcessing({gbrain:a,resources,reviewer:{model:'local-synthetic',async review(){order.push('learn-A');return[];}}});scheduleMemoryProcessing({gbrain:b,resources,reviewer:{review(){}}});
  const background=reviewer.review({text:'synthetic'}),indexing=b.indexPending(),foreground=a.search({query:'synthetic'});assert.deepEqual(order,[]);
  release();await Promise.all([background,indexing,foreground]);assert.deepEqual(order,['search-A','learn-A','index-B']);assert.equal(resources.status().active.gpu,0);resources.close();
});
test('revoked queued learning never invokes its model and failures release the GPU',async()=>{
  const resources=createExecutionSlots(),release=await resources.acquire({kind:'gpu'}),controller=new AbortController();let calls=0;
  const reviewer=scheduleMemoryProcessing({gbrain:{},resources,reviewer:{async review(){calls++;throw new Error('Synthetic model failure');}}});
  const waiting=reviewer.review({signal:controller.signal});controller.abort();await assert.rejects(waiting,/cancelled/);release();assert.equal(calls,0);
  await assert.rejects(reviewer.review({}),/Synthetic model failure/);assert.equal(resources.status().active.gpu,0);resources.close();
});

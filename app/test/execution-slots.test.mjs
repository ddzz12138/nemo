import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionSlots } from '../lib/execution-slots.mjs';

test('cloud admission is capped at two and a cancelled queue entry never runs', async () => {
  const slots=createExecutionSlots(),one=await slots.acquire(),two=await slots.acquire();let admitted=false;
  const controller=new AbortController();const third=slots.acquire({signal:controller.signal}).then(release=>{admitted=true;release();});controller.abort();await assert.rejects(third,/cancelled/);
  assert.equal(admitted,false);assert.equal(slots.status().active.cloud,2);one();one();two();assert.equal(slots.status().active.cloud,0);slots.close();
});

test('one heavy GPU job runs and queued foreground work is prioritized over learning', async () => {
  const slots=createExecutionSlots(),initial=await slots.acquire({kind:'gpu'}),order=[];
  const background=slots.acquire({kind:'gpu',foreground:false}).then(release=>{order.push('background');release();});
  const foreground=slots.acquire({kind:'gpu'}).then(release=>{order.push('foreground');release();});
  initial();await Promise.all([background,foreground]);assert.deepEqual(order,['foreground','background']);assert.equal(slots.status().active.gpu,0);slots.close();
});

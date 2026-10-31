import test from 'node:test';
import assert from 'node:assert/strict';
import {createActivity,recordActivity,publicActivity,interruptActivity,THINKING_WORDS} from '../lib/activity.mjs';
import {createHermesEventPolicy} from '../lib/hermes.mjs';
test('waiting words require startup proof and never accept arbitrary provider text',()=>{
  assert.equal(THINKING_WORDS.length,15);
  const p=createHermesEventPolicy();assert.throws(()=>p.observe({type:'nemo_status',phase:'thinking',verb:'mulling'}));
  p.observe({type:'nemo_guard',version:1,stage:'startup',tools:[]});
  for(const verb of THINKING_WORDS)p.observe({type:'nemo_status',phase:'thinking',verb});
  p.observe({type:'nemo_status',phase:'idle',verb:null});
  for(const event of [{verb:'PRIVATE_TEXT',phase:'thinking'},{verb:null,phase:'thinking'},{verb:'mulling',phase:'idle'},{verb:'mulling',phase:'thinking',output:'SECRET'}])assert.throws(()=>p.observe({type:'nemo_status',...event}));
});
test('activity projects only approved labels and correlates independent same-name tools',()=>{
  const a=createActivity('run');
  recordActivity(a,{kind:'thinking',verb:'mulling',input:'SECRET'},100);
  recordActivity(a,{kind:'tool',name:'mcp__nemo__gmail_search',key:'a'},110);
  recordActivity(a,{kind:'tool',name:'mcp__nemo__gmail_search',key:'b'},120);
  recordActivity(a,{kind:'tool',name:'mcp__nemo__gmail_search',key:'b',state:'failed',output:'SECRET'},140);
  recordActivity(a,{kind:'tool',name:'mcp__nemo__gmail_search',key:'a',state:'completed'},150);
  recordActivity(a,{kind:'answer'},160);recordActivity(a,{kind:'run',state:'completed'},170);
  assert.equal(a.pending,false);assert.equal(a.attention,true);assert.equal(a.entries.find(e=>e.key==='tool:a').durationMs,40);
  assert.equal(JSON.stringify(publicActivity(a)).includes('SECRET'),false);
  assert.equal(recordActivity(a,{kind:'tool',name:'terminal',key:'bad'}),false);
  assert.equal(a.entries.some(e=>e.label.includes('Found')),false);
});
test('answer completion and actual local memory completion are independent',()=>{
  const a=createActivity('run');recordActivity(a,{kind:'answer'},1);recordActivity(a,{kind:'run',state:'completed'},2);
  recordActivity(a,{kind:'memory',phase:'queued'},3);recordActivity(a,{kind:'memory',phase:'reviewing'},4);assert.equal(a.pending,true);
  recordActivity(a,{kind:'memory',phase:'saving'},5);assert.equal(a.entries.some(e=>e.label==='1 memory saved'),false);
  recordActivity(a,{kind:'memory',phase:'saved',added:1,updated:0},6);assert.equal(a.pending,false);assert.equal(a.entries.at(-1).label,'1 memory saved');
  assert.equal(recordActivity(a,{kind:'memory',phase:'saved',added:0,updated:0},7),false);
});
test('interrupted work is terminal and duplicate text chunks do not grow the log',()=>{
  const a=createActivity('run');assert.equal(recordActivity(a,{kind:'answer'},1),true);
  for(let i=0;i<1000;i++)assert.equal(recordActivity(a,{kind:'answer'},2),false);
  recordActivity(a,{kind:'run',state:'completed'},3);recordActivity(a,{kind:'memory',phase:'reviewing'},4);
  interruptActivity(a,5);assert.equal(a.pending,false);assert.equal(a.attention,true);assert.equal(a.entries.some(e=>e.state==='running'),false);
});
test('bounded activity retains later failures',()=>{
  const a=createActivity('run');for(let i=0;i<200;i++){recordActivity(a,{kind:'thinking',verb:THINKING_WORDS[i%15]},i*2);recordActivity(a,{kind:'thinking',state:'completed'},i*2+1);}
  recordActivity(a,{kind:'run',state:'failed'},500);assert.equal(a.pending,false);assert.equal(a.entries.length,64);assert.equal(a.entries.at(-1).state,'failed');
});

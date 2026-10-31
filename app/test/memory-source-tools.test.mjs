import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionToolRunner,connectionTools} from '../lib/connections.mjs';
test('memory MCP source choices are bounded and invalid sources fail before storage',async()=>{
  assert.deepEqual(connectionTools.find(tool=>tool.name==='memory_search').inputSchema.properties.source.enum,['notes','gmail','all']);
  let calls=0;const run=createConnectionToolRunner({gbrain:{status:async()=>{calls++;return {connected:true};},search:async()=>({items:[],hasMore:false})}});
  for(const source of [null,3,[],{},'inbox','../private','calendar'])await assert.rejects(run('memory_search',{query:'trip',source}));
  assert.equal(calls,0);
});
test('MCP copies include provenance and reject a result from a different requested source',async()=>{
  const item={slug:'nemo-notes/gmail/0123456789abcdef0123456789abcdef',kind:'email',status:'active',title:'Ticket',summary:'Window seat',sourceLabel:'Gmail snippet · mirrored locally',credentials:'MUST_NOT_LEAK'};
  const run=createConnectionToolRunner({gbrain:{status:async()=>({connected:true}),search:async input=>({items:[item],hasMore:false})}});
  const result=await run('memory_search',{query:'trip',source:'gmail'});
  assert.equal(result.items[0].sourceKind,'email');assert.match(result.items[0].sourceLabel,/Gmail/);assert.equal(JSON.stringify(result).includes('MUST_NOT_LEAK'),false);
  await assert.rejects(run('memory_search',{query:'trip'}),/outside the requested source/);
  await assert.rejects(run('memory_search',{query:'trip',source:'calendar'}),/Invalid memory source/);
  assert.equal((await run('memory_search',{query:'trip',source:'all'})).items.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeGbrainHome } from '../lib/gbrain-setup.mjs';

test('portable Memory initialization refuses overwrite and strips provider environment',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nemo-init-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataDir=join(root,'memory'); const calls=[];
  const execute=async(args,env)=>{calls.push({args,env});if(args[0]==='init'){await mkdir(join(dataDir,'.gbrain'));await writeFile(join(dataDir,'.gbrain','config.json'),JSON.stringify({engine:'pglite',embedding_disabled:false,embedding_model:'ollama:nomic-embed-text',embedding_dimensions:768,database_path:join(dataDir,'.gbrain','brain.pglite'),memory:{auto_writeback:'off'},self_upgrade:{mode:'off'}}));}};
  await initializeGbrainHome(dataDir,{runtimePath:join(root,'bun'),sourceRoot:join(root,'source')},{execute});
  assert.ok(calls[0].args.includes('ollama:nomic-embed-text'));assert.ok(calls.some(call=>call.args.includes('facts.extraction_enabled')));
  assert.ok(calls.every(call=>!Object.keys(call.env).some(key=>/API_KEY|TOKEN|SECRET|DATABASE_URL/.test(key))));
  const before=calls.length;await assert.rejects(initializeGbrainHome(dataDir,{runtimePath:join(root,'bun'),sourceRoot:join(root,'source')},{execute}),/preserved/);assert.equal(calls.length,before);
});

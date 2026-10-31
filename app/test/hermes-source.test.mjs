import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHermesSourceManifest,verifyHermesSource } from '../lib/hermes-source.mjs';
test('vendored runtime source requires exact complete bytes and rejects additions or unsafe pins',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nemo-source-pin-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'vendor/hermes-source');await mkdir(dir,{recursive:true});
  const files=[];for(const path of ['LICENSE','pyproject.toml','hermes_bootstrap.py']){const value=path==='LICENSE'?'MIT fixture':'# synthetic';await writeFile(join(dir,path),value);files.push({path,bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});}
  await writeFile(join(dir,'.gitattributes'),'* -text');await writeFile(join(dir,'UPSTREAM.md'),'Synthetic source');
  const manifest={version:1,root:'vendor/hermes-source',sourceRevision:'a'.repeat(40),files,reviewedWindowsPathExamples:[]};
  assert.equal((await verifyHermesSource(root,manifest)).verified,true);
  for(const value of [{...manifest,root:'../escape'},{...manifest,files:[...files,files[0]]},{...manifest,files:[...files,{path:'optional-skills/private.md',bytes:0,sha256:'a'.repeat(64)}]}])assert.throws(()=>validateHermesSourceManifest(value));
  await writeFile(join(dir,'.env'),'SYNTHETIC_PRIVATE');await assert.rejects(verifyHermesSource(root,manifest),/unpinned/);await rm(join(dir,'.env'));
  await writeFile(join(dir,'hermes_bootstrap.py'),'changed');await assert.rejects(verifyHermesSource(root,manifest),/changed/);
});

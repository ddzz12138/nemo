import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadPinnedArtifact, validateReleaseInputs } from '../lib/release-inputs.mjs';
import { signingOptions, signOwnedWindowsFiles } from '../lib/windows-signing.mjs';
const data = Buffer.from('Synthetic verified wheel'), digest = createHash('sha256').update(data).digest('hex');
const item = {name:'fixture',version:'1.0',file:'fixture-1.0-py3-none-any.whl',url:'https://files.pythonhosted.org/packages/example/fixture-1.0-py3-none-any.whl',bytes:data.length,sha256:digest};

test('artifact download validates exact bytes, rechecks cached content and leaves no failed partial', async t => {
  const root = await mkdtemp(join(tmpdir(),'nemo-pins-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path = await downloadPinnedArtifact(item,root,{fetchImpl:async()=>new Response(data)});
  assert.deepEqual(await readFile(path),data);
  await downloadPinnedArtifact(item,root,{fetchImpl:assert.fail});
  await writeFile(path,'changed');await assert.rejects(downloadPinnedArtifact(item,root,{fetchImpl:assert.fail}),/Cached/);
  await rm(path);
  for (const fetchImpl of [async()=>new Response('short'),async()=>new Response(Buffer.alloc(data.length+1)),async()=>new Response(null,{status:500}),async()=>{throw new Error('offline');}]) {
    await assert.rejects(downloadPinnedArtifact(item,root,{fetchImpl}));
    assert.deepEqual(await readdir(root),[]);
  }
  for(const changed of [{file:'../escape.whl'},{url:item.url.replace('files.pythonhosted.org','evil.test')},{sha256:'x'},{bytes:0}])await assert.rejects(downloadPinnedArtifact({...item,...changed},root,{fetchImpl:assert.fail}));
});

test('real release input lock rejects duplicate wheels, wrong platform and Python version mismatch', async () => {
  const lock=JSON.parse(await readFile(new URL('../desktop/hermes-release.json',import.meta.url),'utf8'));
  assert.equal(validateReleaseInputs(lock),lock);
  for(const changed of [{arch:'arm64'},{pythonVersion:'3.14.99'},{packages:[...lock.packages,lock.packages[0]]},{packages:[{...lock.packages[0],name:'../escape'}]}])assert.throws(()=>validateReleaseInputs({...lock,...changed}));
});

test('signing fails closed for missing identity and cannot mutate pinned runtime files', async () => {
  assert.equal(signingOptions({}),null);
  assert.throws(()=>signingOptions({NEMO_REQUIRE_SIGNING:'1'}));
  const env={NEMO_REQUIRE_SIGNING:'1',NEMO_SIGN_CERTIFICATE_FILE:resolve('synthetic.pfx'),NEMO_SIGN_CERTIFICATE_PASSWORD:'synthetic-password',NEMO_SIGN_EXPECTED_THUMBPRINT:'a'.repeat(40)};
  await assert.rejects(signOwnedWindowsFiles([resolve('python.exe')],{env,sign:assert.fail}));
  let options;await signOwnedWindowsFiles([resolve('Nemo.exe')],{env,sign:async value=>{options=value;}});
  assert.deepEqual(options.files,[resolve('Nemo.exe')]);assert.deepEqual(options.hashes,['sha256']);
  await assert.rejects(signOwnedWindowsFiles([resolve('NemoSetup.exe')],{env,sign:async()=>{throw new Error('signing failed');}}),/signing failed/);
});

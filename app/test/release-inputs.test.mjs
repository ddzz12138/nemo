import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadPinnedArtifact, validateReleaseInputs, prepareReleaseInputs } from '../lib/release-inputs.mjs';
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
  for(const changed of [{NEMO_SIGN_CERTIFICATE_FILE:'relative.pfx'},{NEMO_SIGN_CERTIFICATE_PASSWORD:''},{NEMO_SIGN_EXPECTED_THUMBPRINT:'wrong'}])assert.throws(()=>signingOptions({...env,...changed}),/required/);
  assert.deepEqual(await signOwnedWindowsFiles([],{env:{},sign:()=>assert.fail('Diagnostic builds must not call a signer')}),{signed:false,diagnosticBuild:true});
  await assert.rejects(signOwnedWindowsFiles([resolve('python.exe')],{env,sign:assert.fail}));
  for(const files of [null,[],['Nemo.exe']])await assert.rejects(signOwnedWindowsFiles(files,{env,sign:()=>assert.fail('Invalid signing targets must not call a signer')}),/Only the Nemo/);
  let options;await signOwnedWindowsFiles([resolve('Nemo.exe')],{env,sign:async value=>{options=value;}});
  assert.deepEqual(options.files,[resolve('Nemo.exe')]);assert.deepEqual(options.hashes,['sha256']);assert.equal(options.debug,false);
  await assert.rejects(signOwnedWindowsFiles([resolve('NemoSetup.exe')],{env,sign:async()=>{throw new Error('signing failed');}}),/signing failed/);
});

test('runtime preparation rejects unsafe archive members and wrong Python before dependency installation', async t => {
  const root=await mkdtemp(join(tmpdir(),'nemo-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const python={file:'cpython-3.14.1+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',url:'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.14.1%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',bytes:data.length,sha256:digest};
  const lock={version:1,platform:'win32',arch:'x64',pythonVersion:'3.14.1',python,packages:[item]};
  if(process.platform!=='win32'||process.arch!=='x64'){
    await assert.rejects(prepareReleaseInputs({lock,cache:root,fetchImpl:assert.fail,run:assert.fail}),/Windows x64/);return;
  }
  for(const listing of ['', 'outside/python.exe\n','python/../escape.exe\n','python\\python.exe\n']){
    const calls=[];
    await assert.rejects(prepareReleaseInputs({lock,cache:root,fetchImpl:async()=>new Response(data),run:async(file,args)=>{calls.push({file,args});return {stdout:listing};}}),/Unsafe/);
    assert.deepEqual(calls.map(call=>call.args[0]),['-tf']);
  }
  const calls=[];
  await assert.rejects(prepareReleaseInputs({lock,cache:root,fetchImpl:assert.fail,run:async(file,args)=>{calls.push({file,args});return {stdout:file==='tar'?'python/python.exe\n':'Python 3.14.2\n'};}}),/version differs/);
  assert.deepEqual(calls.map(call=>call.args[0]),['-tf','-xf','-I']);
  assert.equal(calls.some(call=>call.args.includes('pip')),false);
});

test('runtime preparation uses fresh extraction and an isolated hash-required offline wheel installation', async t => {
  if(process.platform!=='win32'||process.arch!=='x64')return;
  const root=await mkdtemp(join(tmpdir(),'nemo-prepare-isolated-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const python={file:'cpython-3.14.1+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',url:'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.14.1%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',bytes:data.length,sha256:digest};
  const lock={version:1,platform:'win32',arch:'x64',pythonVersion:'3.14.1',python,packages:[item]},calls=[];
  const run=async(file,args,options)=>{calls.push({file,args,options});return {stdout:file==='tar'?'python/python.exe\n':'Python 3.14.1\n'};};
  const first=await prepareReleaseInputs({lock,cache:root,fetchImpl:async()=>new Response(data),run});
  const second=await prepareReleaseInputs({lock,cache:root,fetchImpl:assert.fail,run});
  assert.notEqual(first.pythonRoot,second.pythonRoot);
  const install=calls.find(call=>call.args.includes('pip'));
  for(const arg of ['-I','-B','--isolated','--no-index','--only-binary=:all:','--no-deps','--no-compile','--require-hashes','--no-cache-dir'])assert.ok(install.args.includes(arg),arg);
  assert.equal(install.options.windowsHide,true);
  const requirements=install.args[install.args.indexOf('-r')+1];
  assert.equal(await readFile(requirements,'utf8'),`fixture==1.0 --hash=sha256:${digest}\n`);
  await assert.rejects(prepareReleaseInputs({lock,cache:root,fetchImpl:assert.fail,run:async(file,args,options)=>{if(args.includes('pip'))throw new Error('installation refused');return run(file,args,options);}}),/installation refused/);
});

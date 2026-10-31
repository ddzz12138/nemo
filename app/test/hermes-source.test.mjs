import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHermesSourceManifest,verifyHermesSource } from '../lib/hermes-source.mjs';
import { verifyPublicSource } from '../lib/source-publication.mjs';
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

async function sourceFixture(t,extra={}){
  const root=await mkdtemp(join(tmpdir(),'nemo-source-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'vendor/hermes-source'),files=[];
  await mkdir(dir,{recursive:true});
  for(const [path,value] of Object.entries({LICENSE:'MIT fixture','pyproject.toml':'# synthetic','hermes_bootstrap.py':'# synthetic',...extra})){
    await mkdir(join(dir,path,'..'),{recursive:true});await writeFile(join(dir,path),value);
    files.push({path,bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});
  }
  await writeFile(join(dir,'.gitattributes'),'* -text');await writeFile(join(dir,'UPSTREAM.md'),'Synthetic source');
  const manifest={version:1,root:'vendor/hermes-source',sourceRevision:'a'.repeat(40),files,reviewedWindowsPathExamples:[]};
  await mkdir(join(root,'desktop'));await writeFile(join(root,'desktop/hermes-source.json'),JSON.stringify(manifest));
  return {root,dir,manifest};
}

test('source pins never bypass private-content checks or allow arbitrary binary files',async t=>{
  for(const value of ['ghp_'+'A'.repeat(36),['C:','Users','Example','private.py'].join('/')]){
    const fixture=await sourceFixture(t,{'agent/example.py':value});
    await assert.rejects(verifyHermesSource(fixture.root,fixture.manifest),/private source content/);
  }
  const binary=await sourceFixture(t,{'agent/example.py':Buffer.from([1,0,2])});
  await assert.rejects(verifyHermesSource(binary.root,binary.manifest),/Unexpected binary/);
  const reviewed=await sourceFixture(t,{'agent/example.py':['C:','Users','Example','public-example.py'].join('/'),'assets/example.png':Buffer.from([1,0,2])});
  reviewed.manifest.reviewedWindowsPathExamples=['agent/example.py'];
  assert.equal((await verifyHermesSource(reviewed.root,reviewed.manifest)).verified,true);
  await rm(join(reviewed.dir,'hermes_bootstrap.py'));
  await assert.rejects(verifyHermesSource(reviewed.root,reviewed.manifest),/missing/);
});

test('public source integration grants the vendor exception only to exact pinned files',async t=>{
  const fixture=await sourceFixture(t,{'assets/example.png':Buffer.from([1,0,2])});
  const paths=['desktop/hermes-source.json',...fixture.manifest.files.map(item=>'vendor/hermes-source/'+item.path),'vendor/hermes-source/.gitattributes','vendor/hermes-source/UPSTREAM.md'];
  assert.equal((await verifyPublicSource(fixture.root,paths)).verified,true);
  await assert.rejects(verifyPublicSource(fixture.root,[...paths,paths[1]]),/Invalid vendor inventory/);
  await assert.rejects(verifyPublicSource(fixture.root,[...paths,'vendor/hermes-source/../outside.py']),/Invalid vendor inventory/);
  await writeFile(join(fixture.root,'outside.png'),Buffer.from([1,0,2]));
  await assert.rejects(verifyPublicSource(fixture.root,[...paths,'outside.png']),/Excluded source path/);
  await writeFile(join(fixture.dir,'UPSTREAM.md'),'ghp_'+'A'.repeat(36));
  await assert.rejects(verifyPublicSource(fixture.root,paths),/Private content/);
});

test('pinned source refuses linked roots, linked descendants and missing provenance',async t=>{
  const fixture=await sourceFixture(t);
  await symlink(fixture.dir,join(fixture.dir,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyHermesSource(fixture.root,fixture.manifest),/links/);
  await rm(join(fixture.dir,'linked'));
  await rm(join(fixture.dir,'UPSTREAM.md'));
  await assert.rejects(verifyHermesSource(fixture.root,fixture.manifest),/provenance metadata missing/);
  const linked=await mkdtemp(join(tmpdir(),'nemo-source-root-'));t.after(()=>rm(linked,{recursive:true,force:true}));
  await symlink(join(fixture.root,'vendor'),join(linked,'vendor'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(verifyHermesSource(linked,fixture.manifest),/root cannot be a link/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,symlink,rmdir,unlink,rm,lstat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const bundled=resolve('.work/desktop-runtime/hermes/python/python.exe');
const python=process.env.NEMO_TEST_PYTHON||(process.platform==='win32'?(existsSync(bundled)?bundled:null):'python3');

test('MCP handoff preserves Windows root aliases and rejects foreign or redirected profiles',{skip:!python},async t=>{
  const parent=resolve('.work/test-fixtures');await mkdir(parent,{recursive:true});
  const fixture=await mkdtemp(join(parent,'mcp-paths-')),links=[];
  t.after(async()=>{
    assert.equal(dirname(fixture),parent);
    for(const link of links){assert.equal((await lstat(link)).isSymbolicLink(),true);if(process.platform==='win32')await rmdir(link);else await unlink(link);}
    await rm(fixture,{recursive:true,force:true});
  });
  const root=join(fixture,'physical'),alias=join(fixture,'logical'),foreign=join(fixture,'foreign'),id=randomUUID(),other=randomUUID(),escaped=randomUUID();
  const data=join(root,'profiles',id),otherData=join(root,'profiles',other),escapeData=join(foreign,'profiles',escaped);
  for(const directory of [data,otherData,escapeData])await mkdir(directory,{recursive:true});
  await symlink(root,alias,process.platform==='win32'?'junction':'dir');links.push(alias);
  const redirect=join(root,'profiles',escaped);await symlink(escapeData,redirect,process.platform==='win32'?'junction':'dir');links.push(redirect);
  const cases=[
    {case:'ordinary profile',data,root,profile:id,allowed:true},
    {case:'physical data plus logical root alias',data,root:alias,profile:id,allowed:true},
    {case:'logical data plus physical root',data:join(alias,'profiles',id),root,profile:id,allowed:true},
    {case:'another person',data:otherData,root:alias,profile:id,allowed:false},
    {case:'another root',data:escapeData,root,profile:escaped,allowed:false},
    {case:'profile directory redirected outside its root',data:redirect,root,profile:escaped,allowed:false},
    {case:'relative root',data,root:'relative',profile:id,allowed:false},
    {case:'missing root',data,root:null,profile:id,allowed:false},
    {case:'prompt-like profile',data,root,profile:'../'+id,allowed:false},
  ];
  const script=fileURLToPath(new URL('./fixtures/hermes-mcp-paths.py',import.meta.url));
  const guard=fileURLToPath(new URL('../lib/hermes_guard.py',import.meta.url));
  const result=spawnSync(python,['-I','-B',script,guard],{input:JSON.stringify(cases),encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout),{ok:true,cases:cases.length,modelCalled:false});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { APP_ROOT } from '../lib/config.mjs';
import { exportPhoneApp } from '../scripts/export-phone-app.mjs';

test('static phone export contains the runtime graph and no private or host setup files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nemo-phone-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const out=await exportPhoneApp(join(root,'static'));
  const files=[];
  async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false);
    if(entry.isDirectory())await walk(path);else files.push(path);
  }}
  await walk(out);
  assert.deepEqual(JSON.parse(await readFile(join(out,'phone-app.json'),'utf8')),{service:'nemo-phone-app',protocol:1,static:true});
  assert.match(await readFile(join(out,'phone-app-config.js'),'utf8'),/NEMO_PHONE_APP = true/);
  assert.match(await readFile(join(APP_ROOT,'public','phone-app-config.js'),'utf8'),/NEMO_PHONE_APP = false/);
  assert.ok(!files.some(path=>/host-setup|\.dpapi$|\.sqlite|\.db$|profiles\.json|package-lock\.json|server\.mjs/.test(path)));
  for(const relative of ['phone-start.html','pair.html','vendor/phone-link/nostr/index.mjs','vendor/phone-link/core/index.mjs','vendor/phone-link/secp256k1/index.js','vendor/phone-link/nostr/LICENSE'])assert.ok(files.includes(join(out,relative)));
  for(const path of files.filter(path=>/\.(?:mjs|js)$/.test(path))){
    // Ignore JSDoc example imports in upstream vendored modules.
    const source=(await readFile(path,'utf8')).replace(/^\s*\*.*$/gm,'');
    for(const match of source.matchAll(/(?:\bimport\s+(?:[\w*{},\s]+?\s+from\s*)?|\bexport\s*\{[^}]*\}\s*from\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)){
      const target=match[1];assert.ok(target.startsWith('.')||target.startsWith('/'),'Unexpected runtime import: '+target);
      const destination=target.startsWith('/')?join(out,target.slice(1)):resolve(path,'..',target);
      assert.ok(files.includes(destination),'Missing exported module: '+target);
    }
  }
  await assert.rejects(exportPhoneApp(out),{code:'EEXIST'});
  await assert.rejects(exportPhoneApp(join(APP_ROOT,'public','nested-export')),/outside public/);
});

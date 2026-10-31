import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { candidateIdentity,storeDraftCandidate } from '../lib/candidate-release.mjs';
const commit='a'.repeat(40),repository='owner/repository';
const identity=candidateIdentity({version:'1.0.0-alpha.1',commit,runId:'12',attempt:'1'});
const assets=[{name:'NemoSetup.exe',bytes:Buffer.from('SYNTHETIC_SIGNED_BYTES')},{name:'candidate.json',bytes:Buffer.from('{}')}];
function service(){
  let release;const uploaded=[],calls=[];
  const request=async(method,url,body)=>{
    calls.push({method,url});const u=new URL(url);
    if(u.hostname==='uploads.github.com'){
      const name=u.searchParams.get('name');if(uploaded.some(x=>x.name===name))throw new Error('duplicate');
      const asset={name,size:body.length,digest:'sha256:'+createHash('sha256').update(body).digest('hex')};uploaded.push(asset);return asset;
    }
    if(method==='POST'){if(release)throw new Error('exists');release={...body,id:1,html_url:'https://example.test/draft'};return release;}
    if(u.pathname.endsWith('/releases'))return release?[release]:[];
    if(u.pathname.endsWith('/assets'))return uploaded;
    return release;
  };
  return {request,uploaded,calls,get release(){return release;}};
}
test('candidate identities are immutable and malformed source/run/version values reject',()=>{
  assert.ok(identity.startsWith('candidate-v1.0.0-alpha.1-'));
  for(const changed of [{commit:'main'},{runId:'../x'},{version:'1;publish'},{attempt:'a'}])assert.throws(()=>candidateIdentity({version:'1.0.0',commit,runId:'12',attempt:'1',...changed}));
});
test('draft storage resumes identical assets, never publishes or overwrites changed bytes',async()=>{
  const api=service(),options={request:api.request,repository,identity,commit,assets};
  assert.equal((await storeDraftCandidate(options)).draft,true);assert.equal(api.release.draft,true);
  assert.deepEqual(api.uploaded.map(x=>x.name),['NemoSetup.exe','candidate.json']);
  await storeDraftCandidate(options);assert.equal(api.uploaded.length,2);
  await assert.rejects(storeDraftCandidate({...options,assets:[{...assets[0],bytes:Buffer.from('CHANGED')},assets[1]]}),/differs/);
  api.release.draft=false;
  const before=api.calls.length;await assert.rejects(storeDraftCandidate(options),/published/);
  assert.ok(api.calls.slice(before).every(x=>x.method==='GET'));
  assert.ok(api.calls.every(x=>x.method!=='DELETE'&&x.method!=='PATCH'));
});
test('interrupted upload leaves no completion marker and source mismatch refuses all writes',async()=>{
  const api=service();let failed=false;
  const request=(method,url,body)=>{if(url.includes('uploads.github.com')&&!failed){failed=true;throw new Error('interrupted');}return api.request(method,url,body);};
  await assert.rejects(storeDraftCandidate({request,repository,identity,commit,assets}),/interrupted/);
  assert.equal(api.uploaded.length,0);assert.equal(api.release.draft,true);
  await assert.rejects(storeDraftCandidate({request:api.request,repository,identity,commit:'b'.repeat(40),assets}),/another source/);
});

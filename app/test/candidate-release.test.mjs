import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

test('draft storage handles a competing creator and refuses publication or changed upload receipts mid-run',async()=>{
  const api=service();let raced=false;
  const request=async(method,url,body)=>{if(method==='POST'&&url.endsWith('/releases')&&!raced){raced=true;await api.request(method,url,body);throw new Error('competing creator');}return api.request(method,url,body);};
  assert.equal((await storeDraftCandidate({request,repository,identity,commit,assets})).draft,true);
  assert.equal(api.uploaded.length,2);
  for(const mode of ['published','checksum','size']){
    const current=service();
    const mutate=async(method,url,body)=>{
      const result=await current.request(method,url,body);
      if(url.includes('uploads.github.com')){
        if(mode==='published')current.release.draft=false;
        if(mode==='checksum')return {...result,digest:'sha256:'+'0'.repeat(64)};
        if(mode==='size')return {...result,size:result.size+1};
      }
      return result;
    };
    await assert.rejects(storeDraftCandidate({request:mutate,repository,identity,commit,assets}),mode==='published'?/published/:/checksum or size/);
    assert.deepEqual(current.uploaded.map(asset=>asset.name),['NemoSetup.exe']);
  }
});

test('invalid draft assets cannot create a release or upload a completion marker',async()=>{
  const options={request:()=>assert.fail('Unexpected release request'),repository,identity,commit,assets};
  for(const changed of [{repository:'owner/repo/escape'},{commit:'main'},{identity:'public-release'},{assets:[]},{assets:[assets[1],assets[0]]},{assets:[{name:'../escape',bytes:Buffer.from('x')},assets[1]]},{assets:[{name:'NemoSetup.exe',bytes:'text'},assets[1]]}])await assert.rejects(storeDraftCandidate({...options,...changed}),/Invalid/);
});

test('candidate delivery command refuses untrusted workflow context and a mismatched checkout before reading evidence',async()=>{
  const base={...process.env,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'ddzz12138/nemo',GITHUB_TOKEN:'SYNTHETIC_NO_NETWORK_TOKEN',NEMO_REQUIRE_SIGNING:'1',GITHUB_SHA:'0'.repeat(40)};
  const execute=promisify(execFile),script=fileURLToPath(new URL('../scripts/store-candidate.mjs',import.meta.url));
  for(const changed of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/heads/other'},{GITHUB_REPOSITORY:'other/repository'},{GITHUB_TOKEN:''},{NEMO_REQUIRE_SIGNING:'0'}]){
    await assert.rejects(execute(process.execPath,[script],{env:{...base,...changed},windowsHide:true,timeout:10000}),error=>error.code===1&&error.stderr.includes('trusted reviewed-main signing workflow'));
  }
  await assert.rejects(execute(process.execPath,[script],{env:base,windowsHide:true,timeout:10000}),error=>error.code===1&&error.stderr.includes('differs from the workflow revision'));
});

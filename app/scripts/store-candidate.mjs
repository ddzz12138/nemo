import { readFile,readdir,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APP_ROOT } from '../lib/config.mjs';
import { candidateIdentity,storeDraftCandidate } from '../lib/candidate-release.mjs';
import { loadDesktopBundle } from '../lib/setup-runtime.mjs';
import { verifyHermesBundle } from '../lib/hermes-bundle.mjs';

const env=process.env;
if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_REPOSITORY!=='ddzz12138/nemo'||!env.GITHUB_TOKEN||env.NEMO_REQUIRE_SIGNING!=='1')throw new Error('Draft delivery requires the trusted reviewed-main signing workflow.');
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:APP_ROOT,encoding:'utf8',windowsHide:true}).trim();
if(commit!==env.GITHUB_SHA)throw new Error('Candidate checkout differs from the workflow revision.');
const pkg=JSON.parse(await readFile(join(APP_ROOT,'package.json'),'utf8'));
const identity=candidateIdentity({version:pkg.version,commit,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT});
const evidence=join(APP_ROOT,'.work/candidate');
const tests=JSON.parse(await readFile(join(evidence,'tests.json'),'utf8'));
const signatures=JSON.parse(await readFile(join(evidence,'signatures.json'),'utf8'));
if(!tests.verified||tests.failed.length||tests.missing.length||tests.unexpectedSkips.length||!signatures.verified||signatures.files.length!==2)throw new Error('Required execution/signature evidence is incomplete.');
const appDirectory=join(APP_ROOT,'out/Nemo-win32-x64');
const bundle=await loadDesktopBundle({resourcesPath:join(appDirectory,'resources'),root:appDirectory});
if(!bundle?.manifest?.hermes||!bundle.node||!bundle.connector)throw new Error('Final packaged runtime is incomplete.');
await verifyHermesBundle({root:bundle.root,manifest:bundle.manifest.hermes});
const output=join(APP_ROOT,'out/make/squirrel.windows/x64');
const names=(await readdir(output)).filter(name=>name==='NemoSetup.exe'||name==='RELEASES'||name.endsWith('-full.nupkg'));
if(!names.includes('NemoSetup.exe')||!names.includes('RELEASES')||names.filter(x=>x.endsWith('-full.nupkg')).length!==1)throw new Error('Squirrel candidate assets are incomplete or mixed.');
const assets=[];
for(const name of names)assets.push({name,bytes:await readFile(join(output,name))});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const item of signatures.files){const bytes=item.file==='Nemo.exe'?await readFile(join(appDirectory,'Nemo.exe')):assets.find(x=>x.name===item.file)?.bytes;if(!bytes||sha(bytes)!==item.sha256||item.thumbprint.toLowerCase()!==env.NEMO_SIGN_EXPECTED_THUMBPRINT.toLowerCase())throw new Error('Final signed bytes or expected identity changed.');}
for(const name of ['tests.json','signatures.json'])assets.push({name,bytes:await readFile(join(evidence,name))});
const manifest={version:1,identity,commit,appVersion:pkg.version,technicalVerified:true,cleanPcVerified:false,adultPilotVerified:false,runtime:bundle.manifest,sourceLockSha256:sha(await readFile(join(APP_ROOT,'desktop/hermes-source.json'))),inputLockSha256:sha(await readFile(join(APP_ROOT,'desktop/hermes-release.json'))),assets:assets.map(x=>({name:x.name,bytes:x.bytes.length,sha256:sha(x.bytes)}))};
const checksums=manifest.assets.map(x=>`${x.sha256}  ${x.name}`).join('\n')+'\n';
assets.push({name:'SHA256SUMS',bytes:Buffer.from(checksums)});
assets.push({name:'candidate.json',bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'candidate.json'),assets.at(-1).bytes);
async function request(method,url,body){
  const binary=body instanceof Uint8Array;
  const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(300000),headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':binary?'application/octet-stream':'application/json'}:{})},...(body?{body:binary?body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error('Draft release request failed with HTTP '+response.status);
  return response.json();
}
console.log(JSON.stringify(await storeDraftCandidate({request,repository:env.GITHUB_REPOSITORY,identity,commit,assets})));

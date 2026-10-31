import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, basename } from 'node:path';

const BOOTSTRAP = String.raw`
const request=JSON.parse(await Bun.stdin.text());
const original=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='11434'||!['/v1/embeddings','/api/embed','/api/embeddings','/api/tags','/api/version','/v1/models'].includes(url.pathname))throw new Error('Only local embeddings are allowed.');return original(input,{...options,redirect:'error'});};
const {pathToFileURL}=await import('node:url');
const {join}=await import('node:path');
process.argv=[process.execPath,join(process.env.NEMO_GBRAIN_SOURCE_ROOT,'src','cli.ts'),...request];
await import(pathToFileURL(join(process.env.NEMO_GBRAIN_SOURCE_ROOT,'src','cli.ts')).href);
`;

export async function initializeGbrainHome(dataDir, { runtimePath, sourceRoot } = {}, { execute } = {}) {
  if (![dataDir,runtimePath,sourceRoot].every(value=>typeof value==='string'&&isAbsolute(value)) || !/^bun(?:\.exe)?$/i.test(basename(runtimePath))) throw new Error('Configure an absolute Bun runtime and GBrain source directory.');
  const configPath=join(dataDir,'.gbrain','config.json');
  try { await stat(configPath); throw new Error('Existing Memory was preserved; initialization cannot replace it.'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const env={ GBRAIN_HOME:dataDir, NEMO_GBRAIN_SOURCE_ROOT:sourceRoot, GBRAIN_SKIP_STARTUP_HOOKS:'1', GBRAIN_NO_RETRY_CONNECT:'1', NO_COLOR:'1', OLLAMA_BASE_URL:'http://127.0.0.1:11434/v1' };
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];
  const run=execute || (args=>new Promise((resolveRun,reject)=>{
    const child=spawn(runtimePath,['--no-env-file','--eval',BOOTSTRAP],{cwd:sourceRoot,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let size=0;let stopped=false;const timer=setTimeout(()=>{stopped=true;child.kill();},60_000);
    const consume=part=>{size+=part.length;if(size>1_000_000){stopped=true;child.kill();}};
    child.stdout.on('data',consume);child.stderr.on('data',consume);child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('The local GBrain runtime could not start.'));});
    child.on('close',code=>{clearTimeout(timer);code===0&&!stopped?resolveRun():reject(new Error('Local Memory initialization did not finish. Existing data was preserved.'));});
    child.stdin.end(JSON.stringify(args));
  }));
  await run(['init','--pglite','--db-only','--search-mode','conservative','--non-interactive','--json','--embedding-model','ollama:nomic-embed-text','--embedding-dimensions','768'],env);
  for(const [key,value] of [['memory.auto_writeback','off'],['facts.extraction_enabled','false'],['auto_chronicle','false'],['auto_link','false'],['loops.extraction_enabled','false'],['autopilot.auto_drain.enabled','false'],['autopilot.git_pull','false'],['autopilot.nightly_quality_probe.enabled','false'],['autopilot.conversation_parser_probe.enabled','false'],['eval.capture','false'],['self_upgrade.mode','off']])await run(['config','set',key,value],env);
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(config.engine!=='pglite'||config.embedding_disabled===true||config.embedding_model!=='ollama:nomic-embed-text'||config.embedding_dimensions!==768||resolve(config.database_path||'')!==resolve(dataDir,'.gbrain','brain.pglite')||config.database_url||config.remote_mcp||config.memory?.auto_writeback!=='off'||config.self_upgrade?.mode!=='off')throw new Error('Local Memory settings could not be verified.');
}

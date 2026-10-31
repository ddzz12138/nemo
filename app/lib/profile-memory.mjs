import {readFile,writeFile,mkdir,stat,lstat,cp,rename,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGbrainClient,createProfileGbrainClient,GbrainError} from './gbrain.mjs';
import {createMemoryMirror} from './memory-mirror.mjs';
import {createMemoryController} from './memory.mjs';
import {createCuratedMemory} from './curated-memory.mjs';
import {initializeGbrainHome} from './gbrain-setup.mjs';
import {createLocalMemoryReviewer} from './local-memory-review.mjs';
import {scheduleMemoryProcessing} from './memory-resources.mjs';

const same=(left,right)=>process.platform==='win32'?resolve(left).toLowerCase()===resolve(right).toLowerCase():resolve(left)===resolve(right);
const setupFailure=()=>new GbrainError('GBRAIN_SETUP','Local memory could not be enabled. Existing data was preserved; check the PC runtime and try again.',503);
async function atomicJson(path,value){const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,path);}
export async function createProfileMemoryRuntime({dataDir,configDir,profileId,gmail,calendar,now=Date.now,setup=initializeGbrainHome,clientFactory=createProfileGbrainClient,localClientFactory=createGbrainClient}={}){
  if(typeof configDir!=='string'||!isAbsolute(configDir)||typeof dataDir!=='string'||!isAbsolute(dataDir)||typeof profileId!=='string'||!/^[a-f0-9-]{36}$/.test(profileId)||!same(dataDir,join(configDir,'profiles',profileId)))throw new GbrainError('GBRAIN_PROFILE','A valid private profile is required for memory.',403);
  const options={nemoDataDir:dataDir,configDir,profileId};
  let client=await clientFactory(options);
  const engine=await client.status();let initialization=null;let failure=false;
  const gbrain={};
  for(const method of ['list','get','getMany','search','save','forget','remove','removeMany','mirrorCopies','indexPending'])gbrain[method]=(...args)=>{
    if(typeof client[method]!=='function')throw new GbrainError('GBRAIN_NOT_CONNECTED','Enable local memory for this profile first.',503);
    return client[method](...args);
  };
  // Only a profile that has never created its private Memory mapping or home
  // can prove there is no source database to clean. Recheck on every use: a
  // later setup attempt, unavailable engine, or damaged mapping must not turn
  // an account switch into a silent bypass of existing source copies.
  gbrain.isUninitialized=async()=>{
    if(typeof client.mirrorCopies==='function'||engine.connected||initialization)return false;
    for(const name of ['gbrain-runtime.json','gbrain-data']){
      try{await lstat(join(dataDir,name));return false;}catch(error){if(error.code!=='ENOENT')return false;}
    }
    return true;
  };
  gbrain.status=()=>client.status();
  const mirror=await createMemoryMirror({dataDir,gbrain,gmail,calendar,now,includeCalendar:false});
  if(engine.connected)await mirror.excludeCalendar();
  const status=()=>({ok:true,...mirror.status(),engine:{...engine},initializing:!!initialization,...(failure?{setupError:'Local memory setup did not finish. Existing data was preserved. Retry or check the PC.'}:{})});
  async function initialize(){
    // Shared engine template contains runtime locations only, never a database
    // location. No inherited global GBrain mapping or source data is consulted.
    const template=JSON.parse(await readFile(join(configDir,'gbrain-engine.json'),'utf8'));
    if(!template||Array.isArray(template)||Object.keys(template).some(key=>!['runtimePath','sourceRoot'].includes(key)))throw setupFailure();
    const home=join(dataDir,'gbrain-data');
    const candidate=localClientFactory({...template,dataDir:home});
    let existing=false;try{await stat(join(home,'.gbrain/config.json'));existing=true;}catch(error){if(error.code!=='ENOENT')throw setupFailure();}
    if(!existing)await setup(home,template);
    const checked=await candidate.status();
    if(!checked.connected||checked.embedding!=='local-ollama')throw setupFailure();
    const mapping=join(dataDir,'gbrain-runtime.json');await mkdir(dataDir,{recursive:true});
    try{await writeFile(mapping,JSON.stringify({...template,dataDir:home}),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw setupFailure();}
    client=await clientFactory(options);const refreshed=await client.status();for(const key of Object.keys(engine))delete engine[key];Object.assign(engine,refreshed);if(!engine.connected)throw setupFailure();await mirror.excludeCalendar();
  }
  return {gbrain,mirror,engine,status,
    enable(){
      if(engine.connected||initialization)return status();
      failure=false;initialization=Promise.resolve().then(initialize).catch(()=>{failure=true;}).finally(()=>{initialization=null;});
      return status();
    },
    async close(){await initialization;},
  };
}

export async function createProfileMemory({profileId,profileDataDir,configDir,calendar,gmail,getChat,clearChat,assertIdle,now=Date.now,reviewer,resources,...testing}={}) {
  const runtime=await createProfileMemoryRuntime({profileId,dataDir:profileDataDir,configDir,calendar,gmail,now,...testing});
  reviewer=scheduleMemoryProcessing({gbrain:runtime.gbrain,reviewer:reviewer||createLocalMemoryReviewer(),resources});
  const controller=createMemoryController({calendar,gmail,gbrain:runtime.gbrain,mirror:runtime.mirror,getChat,clearChat,assertIdle,profileScoped:true,includeCalendar:false,includeChat:false,now});
  const curation=await createCuratedMemory({dataDir:profileDataDir,profileId,controller,gbrain:runtime.gbrain,engine:()=>runtime.engine,assertIdle,now,...(reviewer?{reviewer}:{})});
  return {...runtime,controller:curation.controller,curation,async close(){await curation.close();await runtime.close();}};
}

export async function createProfileMemoryReader({profileId,profileDataDir}={}) {
  if(typeof profileDataDir!=='string'||!isAbsolute(profileDataDir))throw new GbrainError('GBRAIN_PROFILE','A valid private profile is required for memory.',403);
  return createProfileGbrainClient({profileId,nemoDataDir:profileDataDir,configDir:dirname(dirname(profileDataDir))});
}

async function exists(path){try{await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};

// Offline owner-only import. Called by the family rollout after stopping Nemo
// and creating its private backup. Never reachable through an HTTP/MCP tool.
export async function migrateOwnerMemory({dataDir,profileId}={}) {
  if(typeof dataDir!=='string'||!isAbsolute(dataDir)||typeof profileId!=='string'||!/^[a-f0-9-]{36}$/.test(profileId))throw setupFailure();
  const root=resolve(dataDir);const registry=JSON.parse(await readFile(join(root,'profiles.json'),'utf8'));
  if(registry.ownerProfileId!==profileId||!registry.profiles?.some(profile=>profile.id===profileId&&profile.role==='owner'))throw new GbrainError('GBRAIN_PROFILE','Legacy memory can migrate only to the owner profile.',403);
  const pidFile=join(root,'server.pid');
  if(await exists(pidFile)){const pid=Number((await readFile(pidFile,'utf8')).trim());if(Number.isInteger(pid)&&pid>0&&alive(pid))throw new GbrainError('GBRAIN_BUSY','Stop Nemo before migrating owner memory.',409);}
  const profileDir=join(root,'profiles',profileId),destination=join(profileDir,'gbrain-data'),marker=join(profileDir,'memory-migration.json');
  await mkdir(profileDir,{recursive:true});
  let journal=await exists(marker)?JSON.parse(await readFile(marker,'utf8')):null;
  if(journal?.version===1&&journal.profileId===profileId&&journal.complete===true)return{migrated:true,alreadyComplete:true};
  const legacyMapping=join(root,'gbrain-runtime.json');
  if(!await exists(legacyMapping))return{migrated:false,reason:'no_legacy_memory'};
  const config=JSON.parse(await readFile(legacyMapping,'utf8'));
  const source=join(root,'gbrain-data');
  if(!config||typeof config.dataDir!=='string'||!same(config.dataDir,source)||!await exists(join(source,'.gbrain/config.json')))throw setupFailure();
  if(await exists(join(source,'.gbrain/nemo-engine.lock')))throw new GbrainError('GBRAIN_BUSY','Wait for the legacy memory engine to close before migrating.',409);
  // Validate pinned-local configuration before copying; never follow a custom
  // global database path into a family profile.
  if(!(await createGbrainClient(config).status()).connected)throw setupFailure();
  const template={runtimePath:config.runtimePath,sourceRoot:config.sourceRoot};
  const templatePath=join(root,'gbrain-engine.json');
  if(await exists(templatePath)){const prior=JSON.parse(await readFile(templatePath,'utf8'));if(JSON.stringify(prior)!==JSON.stringify(template))throw setupFailure();}
  else await writeFile(templatePath,JSON.stringify(template),{mode:0o600,flag:'wx'});
  if(await exists(destination)&&(!journal||journal.profileId!==profileId||journal.version!==1))throw new GbrainError('GBRAIN_CONFLICT','The owner already has a memory database. It was preserved; merge it deliberately.',409);
  const temporary=join(profileDir,'.gbrain-owner-migration');
  if(await exists(temporary)&&(!journal||journal.version!==1||journal.profileId!==profileId))throw setupFailure();
  journal={version:1,profileId,complete:false};await atomicJson(marker,journal);
  if(!await exists(destination)){
    if(await exists(temporary)){
      if(!same(temporary,resolve(profileDir,'.gbrain-owner-migration'))||!resolve(temporary).startsWith(resolve(profileDir)+ (process.platform==='win32'?'\\':'/')))throw setupFailure();
      await rm(temporary,{recursive:true,force:true});
    }
    await cp(source,temporary,{recursive:true,errorOnExist:true,filter:path=>!path.endsWith('nemo-engine.lock')});
    const cfgPath=join(temporary,'.gbrain/config.json');const cfg=JSON.parse(await readFile(cfgPath,'utf8'));
    cfg.database_path=join(destination,'.gbrain/brain.pglite');
    await writeFile(cfgPath,JSON.stringify(cfg),{mode:0o600});
    await rename(temporary,destination);
  }
  const mappingPath=join(profileDir,'gbrain-runtime.json');
  const mapping={...template,dataDir:destination};
  if(await exists(mappingPath)){const current=JSON.parse(await readFile(mappingPath,'utf8'));if(!same(current.dataDir||root,destination)||current.runtimePath!==mapping.runtimePath||current.sourceRoot!==mapping.sourceRoot)throw setupFailure();}
  else await writeFile(mappingPath,JSON.stringify(mapping),{mode:0o600,flag:'wx'});
  const mirrorSource=join(root,'memory-mirror.json'),mirrorTarget=join(profileDir,'memory-mirror.json');
  if(await exists(mirrorSource)&&!await exists(mirrorTarget))await cp(mirrorSource,mirrorTarget,{errorOnExist:true});
  const client=await createProfileMemoryReader({profileId,profileDataDir:profileDir});
  if(!(await client.status()).connected)throw setupFailure();
  await atomicJson(marker,{...journal,complete:true});
  return{migrated:true,alreadyComplete:false,legacyPreserved:true};
}

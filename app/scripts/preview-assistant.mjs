import {spawn} from 'node:child_process';
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {APP_ROOT} from '../lib/config.mjs';
import {loadDesktopBundle} from '../lib/setup-runtime.mjs';

// Source-build trial only. Never open or copy an installed family's data.
const dataDir=join(APP_ROOT,'.work','assistant-preview');
if(process.argv.slice(2).some(value=>value!=='--check'))throw new Error('Use npm run preview:assistant, optionally with --check.');
let resourcesPath=join(APP_ROOT,'.work');
try{
  const marker=JSON.parse(await readFile(join(APP_ROOT,'.work','assistant-preview-resources','workspace-runtime-ready.json'),'utf8'));
  if(marker.version!==1||marker.runtime!=='desktop-runtime'||marker.verified!==true)throw new Error('The tools runtime preflight marker is invalid.');
  resourcesPath=join(APP_ROOT,'.work','assistant-preview-resources');
}catch(error){if(error.code!=='ENOENT')throw error;}
const bundle=await loadDesktopBundle({resourcesPath});
if(!bundle?.manifest?.hermes)throw new Error('Prepare the included runtime first: npm run desktop:prepare:candidate');
if(process.argv.includes('--check')){
  console.log(JSON.stringify({bundleLocated:true,runtimeVerified:false,preview:true,separateData:true,port:8795,nativeMemory:true,hermesWorkspace:'local owner',installedAppChanged:false}));
}else{
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const root=await realpath(join(APP_ROOT,'.work')),actual=await realpath(dataDir),within=relative(root,actual);
  if(!within||isAbsolute(within)||within==='..'||within.startsWith('..\\')||within.startsWith('../'))throw new Error('The preview data directory must stay inside this source workspace.');
  console.log('Starting the source preview with its own test profile. Your installed Nemo is unchanged.');
  console.log('Open the private setup link printed below. Connect ChatGPT, then open your personal space.');
  console.log('Memory test: ask Nemo to remember a made-up preference, check Memory, start New Chat and ask for it, then forget it.');
  console.log('Press Ctrl+C to stop this preview. Saved preview chats remain for your next test.');
  const child=spawn(process.execPath,[join(APP_ROOT,'bin','nemo.mjs'),'host-setup'],{cwd:APP_ROOT,env:{...process.env,NEMO_DATA_DIR:dataDir,NEMO_PORT:'8795',NEMO_DESKTOP_RESOURCES_PATH:resourcesPath,NEMO_PUBLIC_ORIGIN:'',NEMO_PRIVATE_URL:'',NEMO_REGISTRATION_URL:''},stdio:['inherit','inherit','inherit','ipc'],shell:false,windowsHide:true});
  let stopTimer;
  const stop=()=>{if(stopTimer)return;console.log('Stopping preview work…');if(child.connected)child.send({type:'nemo:stop'});stopTimer=setTimeout(()=>{console.error('The preview has not confirmed shutdown. Keep this terminal open and press Ctrl+C to retry.');stopTimer=null;},20000);};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  const stopMessage=message=>{if(message?.type==='nemo:stop')stop();};process.on('message',stopMessage);
  child.once('error',()=>{console.error('The source preview could not start.');process.exitCode=1;});
  child.once('exit',code=>{clearTimeout(stopTimer);for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stop);process.removeListener('message',stopMessage);if(process.connected)process.disconnect();process.exitCode=code||0;});
}

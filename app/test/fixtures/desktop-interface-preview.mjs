// Local visual QA fixture. No personal data, live providers, Gmail or Memory.
import { createFamilyServer } from '../../lib/family-server.mjs';
import { createCalendarStore } from '../../lib/calendar.mjs';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const root=resolve('.work/desktop-interface-visual');await mkdir(root,{recursive:true});
const directory=await mkdtemp(join(root,'synthetic-'));
const publicDir=join(directory,'public');await cp(resolve('public'),publicDir,{recursive:true});
const html=await readFile(join(publicDir,'desktop.html'),'utf8');
await writeFile(join(publicDir,'desktop.html'),html.replace('</head>','<link rel="stylesheet" href="/preview.css"></head>').replace('<body>','<body><aside class="fixture-status" role="note">Interface preview · Simulated replies</aside>'));
await writeFile(join(publicDir,'preview.css'),'.fixture-status{flex:none;padding:9px 16px;background:#fff1e5;color:#84401c;border-bottom:1px solid #ead5c3;font:12px/1.5 system-ui;text-align:center}');
const app=await createFamilyServer({dataDir:join(directory,'data'),publicDir,ownerName:'Dan (preview)',memoryFactory:null,logger(){},provider:{status:()=>({connected:true,inferenceProvider:'synthetic-preview'}),async run(input){
 await delay(850,undefined,{signal:input.signal});
 const text='Here’s a simple plan for Saturday:\n\n**Morning**\n- Take a walk together.\n- Pick a place for lunch.\n\n**Afternoon**\nLeave some time free for whatever everyone feels like doing.\n\nThis is a simulated reply for the interface preview.';
 for(const part of text.match(/.{1,36}(?:\s|$)|[\s\S]{1,36}/g)||[]){input.onText?.(part);await delay(90,undefined,{signal:input.signal});}
 return{text};
}},async integrationsForProfile(_profile,{dataDir}){return{calendar:await createCalendarStore({dataDir}),gmail:{async status(){return{connected:false,configured:false};},async syncStatus(){return{mode:'demand',count:0};},async phoneConfiguration(){return{available:false,redirectUri:'',reason:'Gmail is optional and is not connected in this interface preview.'};},async close(){}},gbrain:new Proxy({},{get(){throw new Error('The visual fixture must not access Memory.');}})};}});
app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const origin='http://127.0.0.1:'+app.server.address().port;
const owner=await app.profiles.owner();const invitation=await app.profiles.invite(owner.id);
const record={origin,entry:origin+'/pair.html#invite='+invitation.code,interface:origin+'/desktop.html',synthetic:true,dataDir:directory};
await writeFile(join(root,'active.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({origin,entry:record.entry,synthetic:true}));
let stopping=false;async function close(){if(stopping)return;stopping=true;await app.close();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());

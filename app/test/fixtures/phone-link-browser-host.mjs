// Explicit synthetic browser fixture. Never import this from production.
import http from 'node:http';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join,sep,extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFamilyServer } from '../../lib/family-server.mjs';
import { createPhoneLink } from '../../lib/phone-link.mjs';
import { exportPhoneApp } from '../../scripts/export-phone-app.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const fixtureRoot=await mkdtemp(join(tmpdir(),'nemo-phone-browser-'));
const assets=join(fixtureRoot,'phone-app'),dataDir=join(fixtureRoot,'data');
await exportPhoneApp(assets);
let app,secret=null,turn,forceRelay=false,calls=0,stopping=false;
const epoch=randomUUID();
const staticServer=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    // Match Cloudflare Pages' canonical HTML URLs, including fragment retention
    // across the redirect performed by the browser.
    if(url.pathname.endsWith('.html')){res.writeHead(308,{Location:url.pathname.slice(0,-5)+url.search});res.end();return;}
    const pathname=url.pathname==='/'?'/index.html':extname(url.pathname)?url.pathname:url.pathname+'.html';
    const path=resolve(assets,'.'+pathname);
    if(!path.startsWith(assets+sep)||url.pathname.startsWith('/api/'))throw new Error();
    const data=await readFile(path);
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(path)]||'application/octet-stream');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(resolve=>staticServer.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+staticServer.address().port;
const secrets={async load(){return secret?structuredClone(secret):null;},async save(value){secret=structuredClone(value);}};
async function start(){
  app=await createFamilyServer({dataDir,publicDir:join(root,'public'),logger(){},provider:{status:()=>({connected:true,model:'Synthetic test'}),async run(input){calls++;return{text:'Synthetic response for '+input.profileId+': '+input.message};}},
    nativeFactory:async()=>({status:()=>({available:true,verified:true,tools:0}),isBusy:()=>false,async changes(_profile,after){return{cursor:epoch+':1',events:after?[]:[{cursor:epoch+':1',taskId:epoch}]};},async list(){return{tasks:[]};},async close(){}}),
    phoneLinkFactory:createPhoneLink,phoneLinkOptions:{secretStore:secrets,...(forceRelay?{runtimeFactory:async()=>{
      const[{joinRoom,selfId},{RTCPeerConnection}]=await Promise.all([import('@trystero-p2p/nostr'),import('werift')]);
      return{selfId,joinRoom:(config,id,callbacks)=>joinRoom({...config,rtcPolyfill:RTCPeerConnection,rtcConfig:{iceTransportPolicy:'relay',iceServers:config.turnConfig||[]}},id,callbacks)};
    }}:{})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
}
process.on('message',async message=>{
  try{
    if(message.type==='start'){
      turn=message.turn;forceRelay=message.forceRelay===true;await start();
      await app.phoneLink.configure({appOrigin:origin,...(turn?{turn}:{})});await app.phoneLink.enable();
      const owner=await app.profiles.owner(),other=await app.profiles.create('Synthetic second adult',false);
      const invitations=await Promise.all([app.phoneLink.invite(owner.id),app.phoneLink.invite(other.id)]);
      process.send?.({id:message.id,ok:true,origin,invitations,profiles:[owner.id,other.id]});
    }else if(message.type==='restart'){await app.close();await start();process.send?.({id:message.id,ok:true});}
    else if(message.type==='invite'){process.send?.({id:message.id,ok:true,invitation:await app.phoneLink.invite(message.profileId)});}
    else if(message.type==='revoke'){
      const devices=await app.profiles.devices(message.profileId);for(const device of devices)await app.profiles.revoke(device.id);
      process.send?.({id:message.id,ok:true});
    }else if(message.type==='status')process.send?.({id:message.id,ok:true,calls,status:app.phoneLink.status()});
    else if(message.type==='stop'){
      if(stopping)return;stopping=true;await app?.close();await new Promise(resolve=>staticServer.close(resolve));if(!fixtureRoot.startsWith(join(tmpdir(),'nemo-phone-browser-')))throw new Error('Invalid fixture cleanup target');await rm(fixtureRoot,{recursive:true,force:true});process.exit(0);
    }
  }catch(error){process.send?.({id:message.id,ok:false,error:error.message});}
});
process.on('disconnect',()=>{if(!stopping){stopping=true;void app?.close().finally(()=>process.exit(0));}});

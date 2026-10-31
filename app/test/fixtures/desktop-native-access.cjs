'use strict';
// A real Electron Session + real profile server, with synthetic data only.
const {app,BrowserWindow}=require('electron');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {authorizeDesktopSetup}=require('../../desktop/chat-contracts.cjs');
const root=path.resolve(__dirname,'../../.work/unified-desktop');
mkdirSync(root,{recursive:true});
const directory=mkdtempSync(path.join(root,'native-access-'));
app.setPath('userData',path.join(directory,'electron'));
let server,window;
app.whenReady().then(async()=>{
  const {createFamilyServer}=await import('../../lib/family-server.mjs');
  server=await createFamilyServer({dataDir:path.join(directory,'data'),publicDir:path.resolve(__dirname,'../../public'),memoryFactory:null,logger(){},provider:{status:()=>({connected:false})}});
  await new Promise((done,reject)=>{server.server.once('error',reject);server.server.listen(0,'127.0.0.1',done);});
  const origin='http://127.0.0.1:'+server.server.address().port;
  window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await window.loadURL(origin+'/desktop.html');
  const session=window.webContents.session;
  async function request(route,body,profileId){
    const response=await session.fetch(origin+route,{credentials:'include',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Nemo-Request':'1',Origin:origin,...(profileId?{'X-Nemo-Profile':profileId}:{})},body:JSON.stringify(body)})});
    assert.equal(response.status,200,route);return response.json();
  }
  async function pair(profile){const invite=await server.profiles.invite(profile.id);await request('/api/pair',{code:invite.code,expectedProfileId:profile.id,deviceName:'Synthetic native session'});}
  const owner=await server.profiles.owner(),member=await server.profiles.create('Synthetic member');
  await pair(owner);
  assert.equal((await request('/api/session')).profile.id,owner.id);
  const options={event:{sender:window.webContents,senderFrame:window.webContents.mainFrame},window,setupUrl:'http://127.0.0.1:45555/setup/',appOrigin:origin,profileId:owner.id,fetchSession:()=>request('/api/session')};
  await authorizeDesktopSetup(options);
  await request('/api/logout',{},owner.id);await pair(member);
  assert.equal((await request('/api/session')).profile.id,member.id);
  await assert.rejects(authorizeDesktopSetup({...options,profileId:member.id}),/owner/);
  await assert.rejects(authorizeDesktopSetup(options),/owner/);
  await request('/api/logout',{},member.id);
  await assert.rejects(authorizeDesktopSetup(options),/owner/);
  writeFileSync(path.join(root,'native-access-result.json'),JSON.stringify({ok:true,realElectronSession:true,cookieRoundTrip:true,ownerAccepted:true,memberRejected:true,staleProfileRejected:true,signedOutRejected:true,synthetic:true,realModelCalled:false},null,2)+'\n');
}).catch(error=>{process.exitCode=1;writeFileSync(path.join(root,'native-access-result.json'),JSON.stringify({ok:false,error:error.message},null,2)+'\n');}).finally(async()=>{window?.destroy();await server?.close();app.quit();});

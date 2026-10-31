// Real renderer QA against synthetic family profiles; never a real model/account.
const{app,BrowserWindow,session}=require('electron');
const{spawn}=require('node:child_process');
const{randomUUID,randomBytes}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),relayMode=process.argv.includes('--relay'),work=path.join(root,'.work','phone-link-verification'),evidence=path.join(work,relayMode?'relay':'direct');fs.mkdirSync(evidence,{recursive:true});
app.setPath('userData',path.join(evidence,'browser-profile'));app.setPath('sessionData',path.join(evidence,'browser-session'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-background-networking');

let child,turnChild,windows=[],finished=false,stage='start';const pending=new Map(),started=Date.now();
const deadline=setTimeout(()=>finish({ok:false,error:'Overall deadline'},1),180000);
function finish(result,code){if(finished)return;finished=true;clearTimeout(deadline);for(const win of windows)win.destroy();if(child?.connected)child.send({type:'stop'});turnChild?.stdin.end('quit\n');const record={...result,stage,elapsedMs:Date.now()-started,realModelCalled:false,iphoneCellularVerified:false};fs.writeFileSync(path.join(evidence,relayMode?'relay-browser-result.json':'browser-result.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));setTimeout(()=>{if(child&&child.exitCode===null)child.kill();if(turnChild&&turnChild.exitCode===null)turnChild.kill();app.exit(code);},1000);}
function command(type,input={}){const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Fixture command timed out'));},25000);pending.set(id,{resolve,reject,timer});child.send({id,type,...input});});}
async function wait(win,expression,ms=45000){const until=Date.now()+ms;while(Date.now()<until){if(await win.webContents.executeJavaScript(expression))return;await new Promise(resolve=>setTimeout(resolve,150));}const detail=await win.webContents.executeJavaScript("JSON.stringify({connection:window.NemoPhoneLink?.state,status:document.getElementById('pairStatus')?.textContent,errors:window.__phoneErrors})");throw new Error('Browser condition timed out at '+stage+': '+detail);}
async function browser(name){const isolated=session.fromPartition('nemo-phone-'+name+'-'+randomUUID(),{cache:false});isolated.setPermissionRequestHandler((_w,_p,done)=>done(false));const win=new BrowserWindow({show:false,width:390,height:844,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',details=>{if(details.level==='error')console.log('Browser error: '+details.message.slice(0,300));});if(relayMode){await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:"const NativeRTC=window.RTCPeerConnection;window.RTCPeerConnection=class extends NativeRTC{constructor(config){super({...config,iceTransportPolicy:'relay',iceServers:(config.iceServers||[]).filter(server=>(Array.isArray(server.urls)?server.urls:[server.urls]).some(url=>url.startsWith('turn:')||url.startsWith('turns:')))})}}"});}windows.push(win);return win;}
async function pair(win,url){await win.loadURL(url);await wait(win,"document.getElementById('pairConfirmation')?.hidden === false");await win.webContents.executeJavaScript("document.getElementById('confirmPair').click()");await wait(win,"document.getElementById('pairSuccess')?.hidden === false");}
app.whenReady().then(async()=>{try{
  child=spawn('C:\\Program Files\\nodejs\\node.exe',[path.join(root,'test/fixtures/phone-link-browser-host.mjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  child.on('message',message=>{const task=pending.get(message.id);if(task){pending.delete(message.id);clearTimeout(task.timer);message.ok?task.resolve(message):task.reject(new Error(message.error));}});
  child.on('error',error=>finish({ok:false,error:String(error)},1));
  let turn;
  if(relayMode){
    stage='start-private-turn-fixture';const sharedSecret=randomBytes(32).toString('hex');
    if(!process.env.NEMO_TEST_TURN_BIN)throw new Error('Set NEMO_TEST_TURN_BIN to the built test/fixtures/phone-turn executable.');turnChild=spawn(process.env.NEMO_TEST_TURN_BIN,[],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const config=await new Promise((resolve,reject)=>{let buffer='',errors='';const timer=setTimeout(()=>reject(new Error('Private TURN fixture startup timeout')),10000);turnChild.on('error',reject);turnChild.stderr.on('data',data=>{errors+=data;});turnChild.on('exit',code=>{if(code){clearTimeout(timer);reject(new Error('Private TURN fixture: '+errors.slice(0,300)));}});turnChild.stdout.on('data',data=>{buffer+=data;if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]));}});turnChild.stdin.write(JSON.stringify({sharedSecret})+'\n');});
    turn={urls:[config.url],sharedSecret};
  }
  stage='start-synthetic-host';const host=await command('start',{...(turn?{turn,forceRelay:true}:{})});
  const a=await browser('a');stage='pair-first-phone';console.log(stage);await pair(a,host.invitations[0].url);
  stage='open-main-chat';await a.webContents.executeJavaScript("location.href='/'");await wait(a,"window.NemoIdentity?.profile && !document.getElementById('messageInput').disabled");
  stage='send-real-ui-message';console.log(stage);await a.webContents.executeJavaScript("document.getElementById('messageInput').value='Synthetic browser hello';document.getElementById('messageInput').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chatForm').requestSubmit()");await wait(a,"document.getElementById('messages')?.textContent.includes('Synthetic response')");
  await a.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await a.webContents.capturePage().then(image=>fs.writeFileSync(path.join(evidence,'phone-chat.png'),image.toPNG()));
  stage='native-event-stream';console.log(stage);const streamed=await a.webContents.executeJavaScript("(async()=>{const controller=new AbortController();const response=await window.nemoFetch('/api/native/events',{signal:controller.signal});const part=await response.body.getReader().read();const text=new TextDecoder().decode(part.value);controller.abort();return response.headers.get('content-type').startsWith('text/event-stream')&&text.includes('event: change')})()");if(!streamed)throw new Error('Live stream did not cross the transport');
  if(relayMode){const selected=await a.webContents.executeJavaScript('window.NemoPhoneLink.state.state');if(selected!=='relayed')throw new Error('A forced TURN candidate pair was not selected');finish({ok:true,test:'Full phone UI forced through private TURN REST fixture',selectedRoute:selected,shortLivedCredentials:true,syntheticReplies:1,liveStream:true},0);return;}
  stage='reconnect-and-reload';console.log(stage);await a.webContents.executeJavaScript('window.NemoPhoneLink.reconnect()');await a.reload();await wait(a,"document.getElementById('messages')?.textContent.includes('Synthetic browser hello')");
  stage='restore-cached-phone-page';console.log(stage);await a.webContents.executeJavaScript("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");await wait(a,"window.NemoIdentity?.profile && document.getElementById('messages')?.textContent.includes('Synthetic browser hello')");
  stage='paste-existing-invitation-without-signout';console.log(stage);await a.loadURL(host.origin+'/phone-start');await wait(a,"window.NemoPhoneLink?.enabled && document.getElementById('resumePhone')?.hidden === false");
  await a.webContents.executeJavaScript("document.getElementById('phoneInvitation').value="+JSON.stringify(host.invitations[0].url)+";document.getElementById('phoneInvitationForm').requestSubmit()");await wait(a,"document.getElementById('pairExisting')?.hidden === false");
  await a.loadURL(host.origin+'/');await wait(a,"document.getElementById('messages')?.textContent.includes('Synthetic browser hello')");
  const b=await browser('b');stage='pair-second-phone';console.log(stage);await pair(b,host.invitations[1].url);await b.webContents.executeJavaScript("location.href='/'");await wait(b,'window.NemoIdentity?.profile');
  const isolated=await b.webContents.executeJavaScript("(async()=>{const response=await window.nemoFetch('/api/conversation');return !(await response.text()).includes('Synthetic browser hello')})()");if(!isolated)throw new Error('Cross-profile history leak');
  stage='host-restart';console.log(stage);await command('restart');await a.webContents.executeJavaScript('window.NemoPhoneLink.reconnect()');const recovered=await a.webContents.executeJavaScript("(async()=>{const response=await window.nemoFetch('/api/conversation');return (await response.text()).includes('Synthetic browser hello')})()");if(!recovered)throw new Error('Saved phone key did not survive host restart');
  stage='revoke-second-phone';console.log(stage);await command('revoke',{profileId:host.profiles[1]});const revoked=await b.webContents.executeJavaScript("(async()=>{try{const response=await window.nemoFetch('/api/conversation');return response.status===401;}catch{return true;}})()");if(!revoked)throw new Error('Revoked device retained access');
  stage='explicit-profile-switch';console.log(stage);
  const oldId=JSON.parse(Buffer.from(new URL(host.invitations[0].url).hash.slice(7),'base64url')).id;
  const next=await command('invite',{profileId:host.profiles[1]});await a.loadURL(next.invitation.url);
  await wait(a,"document.getElementById('pairPhoneSwitch')?.hidden === false");
  await a.webContents.executeJavaScript("document.getElementById('phoneSwitchConfirm').click()");
  await wait(a,"document.getElementById('pairConfirmation')?.hidden === false");
  await a.webContents.executeJavaScript("document.getElementById('confirmPair').click()");
  await wait(a,"document.getElementById('pairSuccess')?.hidden === false");
  const oldKeyRemoved=await a.webContents.executeJavaScript("new Promise(resolve=>{const open=indexedDB.open('nemo-phone-keys-v1',1);open.onsuccess=()=>{const request=open.result.transaction('connections','readonly').objectStore('connections').get("+JSON.stringify(oldId)+");request.onsuccess=()=>resolve(!request.result);}})");
  if(!oldKeyRemoved)throw new Error('Previous private phone key survived switching');
  stage='iphone-install-guidance';console.log(stage);
  const mobileInvite=await command('invite',{profileId:host.profiles[0]});
  const safari=await browser('ios-safari');safari.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
  await safari.loadURL(mobileInvite.invitation.url);await wait(safari,"document.getElementById('pairInstall')?.hidden === false");
  const copyReady=await safari.webContents.executeJavaScript("window.NemoPhoneLink.invitationText.startsWith(location.origin+'/pair.html#phone=')");if(!copyReady)throw new Error('iPhone installation copy step unavailable');
  await safari.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await safari.webContents.capturePage().then(image=>fs.writeFileSync(path.join(evidence,'iphone-install.png'),image.toPNG()));
  stage='installed-app-paste-flow';console.log(stage);
  const installed=await browser('ios-installed');installed.webContents.setUserAgent(safari.webContents.getUserAgent());
  await installed.loadURL('about:blank');installed.webContents.debugger.attach('1.3');await installed.webContents.debugger.sendCommand('Page.enable');await installed.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'standalone',{get:()=>true});"});
  await installed.loadURL(host.origin+'/phone-start.html');await installed.webContents.executeJavaScript("document.getElementById('phoneInvitation').value="+JSON.stringify(mobileInvite.invitation.url)+";document.getElementById('phoneInvitationForm').requestSubmit();");
  await wait(installed,"document.getElementById('pairConfirmation')?.hidden === false");await installed.webContents.executeJavaScript("document.getElementById('confirmPair').click()");await wait(installed,"document.getElementById('pairSuccess')?.hidden === false");
  const status=await command('status');if(status.calls!==1)throw new Error('A reconnect duplicated model work');
  finish({ok:true,test:'Full exported phone UI, real Trystero/Nostr, synthetic family gateway',pairedProfiles:2,syntheticReplies:status.calls,liveStream:true,reconnect:true,bfcacheRecoveryEmulated:true,canonicalHtmlRedirects:true,pasteWithoutSignout:true,hostRestart:true,historyIsolation:true,revocation:true,explicitProfileSwitch:true,previousKeyRemoved:true,iphoneGuidanceEmulated:true,installedPasteFlowEmulated:true},0);
}catch(error){finish({ok:false,error:String(error)},1);}});

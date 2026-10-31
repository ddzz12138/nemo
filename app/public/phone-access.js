(() => {
  'use strict';
  const $=id=>document.getElementById(id);let status,invitation,busy=false;
  async function api(path,input){const response=await(window.nemoFetch||fetch)(path,{...(input!==undefined?{method:'POST',body:JSON.stringify(input)}:{}),headers:{'Content-Type':'application/json','X-Nemo-Request':'1'}});const data=await response.json();if(!response.ok)throw new Error(data.error||'This connection is unavailable.');return data;}
  function draw(){
    $('phoneAccessStatus').textContent=status.message;
    $('phoneAppOrigin').value=status.suggestedAppOrigin||status.appOrigin||'';
    for(const id of ['phoneTurnUrls','phoneTurnSecret','phoneClearTurn'])$(id).disabled=status.enabled;
    $('phoneSave').textContent=status.enabled?'Update phone app address ↗':'Save connection setup ↗';
    $('phoneEnable').hidden=status.enabled;$('phoneEnable').disabled=!status.appOrigin;
    $('phoneDisable').hidden=!status.enabled;$('phoneInviteSection').hidden=!status.enabled;
    $('phoneRelayNote').textContent=status.relayConfigured?'Relay fallback is configured. Connectivity still depends on the host and relay being available.':'Direct connections only. Some cellular or restricted networks will need a relay configured by the host.';
  }
  async function action(operation){if(busy)return;busy=true;try{await operation();}catch(error){$('phoneAccessStatus').textContent=error.message;}finally{busy=false;}}
  $('phoneAccessSetup').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
    const input={appOrigin:$('phoneAppOrigin').value.trim()};
    if(!status.enabled&&$('phoneClearTurn').checked)input.turn=null;
    else if(!status.enabled&&$('phoneTurnSecret').value)input.turn={urls:$('phoneTurnUrls').value.split('\n').map(x=>x.trim()).filter(Boolean),sharedSecret:$('phoneTurnSecret').value};
    status=await api('/api/phone-link/configure',input);$('phoneTurnSecret').value='';$('phoneTurnUrls').value='';$('phoneClearTurn').checked=false;draw();
  });});
  $('phoneEnable').addEventListener('click',()=>void action(async()=>{status=await api('/api/phone-link/enable',{});draw();}));
  $('phoneDisable').addEventListener('click',()=>void action(async()=>{status=await api('/api/phone-link/disable',{});invitation=null;$('phoneInviteView').hidden=true;draw();}));
  $('phoneInvite').addEventListener('click',()=>void action(async()=>{
    invitation=await api('/api/phone-link/invitations',{profileId:$('phoneProfile').value});
    $('phoneInviteQr').src=invitation.qrDataUrl;$('phoneInviteName').textContent=invitation.profile.name;
    $('phoneInviteExpiry').textContent='Expires at '+new Date(invitation.expiresAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+'. Connect only this person’s phone.';
    $('phoneInviteView').hidden=false;
  }));
  $('phoneCopyInvite').addEventListener('click',()=>void action(async()=>{if(invitation){await navigator.clipboard.writeText(invitation.url);$('phoneAccessStatus').textContent='Personal invitation copied. Keep it private.';}}));
  void action(async()=>{
    const session=await window.NemoIdentity.load();
    if(!session.authenticated||session.profile.role!=='owner'){ $('phoneAccessStatus').textContent='Open this page on the host in the family owner’s profile.';return;}
    if(window.NemoPhoneLink?.enabled){$('phoneAccessStatus').textContent='Manage phone connection setup on the host.';return;}
    status=await api('/api/phone-link/status');const family=await api('/api/profiles');
    for(const profile of family.profiles.filter(x=>!x.disabled)){const option=document.createElement('option');option.value=profile.id;option.textContent=profile.name;$('phoneProfile').append(option);}
    $('phoneAccessControls').hidden=false;draw();
  });
})();

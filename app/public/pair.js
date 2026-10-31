(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const localDevice=window.location.protocol==='http:'&&['127.0.0.1','localhost'].includes(window.location.hostname);
  // A desktop Gmail handoff has one fixed destination, never an arbitrary return URL.
  const gmailHandoff=localDevice&&new URLSearchParams(window.location.search||'').get('next')==='gmail';
  if(gmailHandoff)for(const id of ['pairContinue','pairStart']){const link=$(id);if(link){link.href='/gmail-connect.html';link.textContent='Continue to Gmail setup ↗';}}
  // Invitations only arrive in fragments. Clear it before any network request or UI work.
  function readInvitation() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = window.NemoPhoneLink?.invitationCode || fragment.get('invite') || '';
    window.history.replaceState(null, '', window.location.pathname);
    fragment.delete('invite');
    return value;
  }
  let code = readInvitation();
  let preview = null, existing = null, busy = false, gone = false, scanPending=false, generation=0;
  function nextScan() { if(scanPending&&!busy&&!gone){scanPending=false;void inspect();} }
  function show(id) { for (const name of ['pairLoading','pairConfirmation','pairExisting','pairSuccess','pairUnavailable','pairInstall','pairPhoneSwitch']) { const element=$(name);if(element)element.hidden = name !== id; } }
  function message(text = '') { $('pairStatus').textContent = text; $('pairStatus').hidden = !text; }
  async function request(path, input, profileId) {
    const headers = {'Content-Type':'application/json','X-Nemo-Request':'1', ...(profileId ? {'X-Nemo-Profile':profileId} : {})};
    const response = await (window.nemoFetch || fetch)(path, {method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers,body:JSON.stringify(input)});
    const data = await response.json();
    if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : data.message || 'Nemo could not connect your phone. Try again.'); error.code=data.code; error.status=response.status; throw error; }
    return data;
  }
  function invitationError(error) {
    if (['PAIR_INVALID','PAIR_EXPIRED','PAIR_PROFILE_MISMATCH'].includes(error.code) || error.status === 401) {
      code=''; preview=null; show('pairUnavailable'); message('This invitation has expired or was already used. Create a new one on the computer.'); $('retryPair').hidden=true; return;
    }
    if (error.status === 429) { message('There have been too many connection attempts. Wait five minutes, then try again.'); return; }
    message(error.message || 'Nemo could not reach your computer. Check that it is awake and online, then try again.'); $('retryPair').hidden = false;
  }
  function showConfirmation() {
    show('pairConfirmation'); $('pairHeading').textContent=`Hello, ${preview.profile.name}.`;
    $('pairDescription').textContent=`Open ${preview.profile.name}’s private Nemo space in ${localDevice?'this browser':'your phone browser'}.`;
    $('confirmPair').textContent=localDevice?'Open my space ↗':'Connect my phone ↗';
    $('pairReview').hidden = !preview.profile.parentalReview;
    $('pairExpiry').textContent = preview.expiresAt ? `This invitation expires at ${new Date(preview.expiresAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}.` : 'This invitation works once.';
  }
  function showExisting() {
    show('pairExisting'); $('existingHeading').textContent=`Hello, ${existing.name}.`;
    const device=localDevice?'This browser':'This phone';
    $('existingDeviceLabel').textContent=`${device} is already connected`;
    $('switchDeviceNote').textContent=`Signing out removes ${localDevice?'this browser':'this phone'}’s access to the current profile. Its saved chats stay on the computer.`;
    $('existingDescription').textContent=preview?.profile.id===existing.id ? `${device} is already connected to your space. You can continue chatting.` : `${device} is signed in as ${existing.name}. To use the invitation for ${preview?.profile.name || 'another person'}, sign out first.`;
    $('switchProfile').hidden=!preview || preview.profile.id===existing.id;
    if(gmailHandoff){const link=$('pairContinue');if(link){const intended=preview?.profile.id===existing.id;link.href=intended?'/gmail-connect.html':'/';link.textContent=intended?'Continue to Gmail setup ↗':'Continue to my chat ↗';}}
  }
  async function inspect() {
    if (busy || gone) return;
    if(window.NemoPhoneLink){try{await window.NemoPhoneLink.ready;}catch(error){show('pairUnavailable');message(error.message);return;}}
    if(window.NemoPhoneLink?.needsSwitch){show('pairPhoneSwitch');$('phoneSwitchConfirm').onclick=async()=>{try{await window.NemoPhoneLink.switchToInvitation();}catch(error){message(error.message);}};return;}
    if (window.NemoPhoneLink?.needsHomeInstall) {
      show('pairInstall');
      $('copyPhoneInvitation').onclick=async()=>{try{const text=window.NemoPhoneLink.invitationText;if(!text)throw new Error();await navigator.clipboard.writeText(text);message('Invitation copied. Add Nemo to your Home Screen, open it and paste the invitation.');}catch{message('Copy the invitation link from the host, then paste it inside the installed Nemo app.');}};
      $('usePhoneBrowser').onclick=()=>{window.NemoPhoneLink.continueInBrowser();void inspect();};
      return;
    }
    const version=generation, invitationCode=code;
    busy=true; message(); $('retryPair').hidden=true;
    try {
      if(window.NemoPhoneLink){await window.NemoPhoneLink.ready;code ||= window.NemoPhoneLink.invitationCode;}
      const session = window.NemoIdentity ? await window.NemoIdentity.load() : await (await fetch('/api/session',{credentials:'same-origin',cache:'no-store'})).json();
      if (gone||version!==generation) return;
      existing=session.profile || null;
      if(existing&&window.NemoPhoneLink?.enabled){showExisting();return;}
      if (!code || !/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(code)) { code=''; if (existing) showExisting(); else show('pairUnavailable'); return; }
      const nextPreview=await request('/api/pair/preview',{code:invitationCode});
      if (gone||version!==generation) return;
      preview=nextPreview;
      if (!preview.profile?.id || !preview.profile?.name) throw new Error('Nemo could not check who this invitation is for. Create a new invitation on the computer.');
      if (existing) showExisting(); else showConfirmation();
    } catch(error) { if(version===generation)invitationError(error); }
    finally { busy=false; nextScan(); }
  }
  $('confirmPair').addEventListener('click', async () => {
    if (busy || !code || !preview || existing) return;
    const version=generation, intendedProfileId=preview.profile.id, invitationCode=code;
    busy=true; $('confirmPair').disabled=true; message('Connecting your phone…');
    try {
      const result=await request('/api/pair',{code:invitationCode,expectedProfileId:intendedProfileId,deviceName:localDevice?'Personal computer browser':'Personal phone'});
      if (gone||version!==generation) return;
      if (result.profile?.id!==intendedProfileId) throw new Error('Nemo could not confirm your profile. Reload before chatting.');
      code=''; existing=result.profile; preview=null;
      $('successHeading').textContent=`You’re home, ${existing.name}.`; show('pairSuccess'); message(); $('retryPair').hidden=true;
      $('pairHomeScreen').hidden=localDevice;$('pairPasskey').hidden=localDevice||window.NemoPhoneLink?.enabled===true;
      if(localDevice)$('pairDeviceNote').textContent='Your chats stay on this computer. Open Nemo any time to return to your space.';
    } catch(error) { if(version===generation)invitationError(error); }
    finally { busy=false; $('confirmPair').disabled=false; nextScan(); }
  });
  $('switchProfile').addEventListener('click', async () => {
    if (busy || !existing || !preview) return;
    const version=generation, previousProfileId=existing.id;
    busy=true; $('switchProfile').disabled=true; message('Signing this phone out…');
    try {
      await request('/api/logout',{},previousProfileId);
      if(gone||version!==generation)return;
      existing=null; message(); showConfirmation();
      // Switching identity never consumes the pending invitation. Confirm is a separate action.
    } catch(error) { if(version===generation)invitationError(error); }
    finally { busy=false; $('switchProfile').disabled=false; nextScan(); }
  });
  $('retryPair').addEventListener('click', () => void inspect());
  window.addEventListener('hashchange',()=>{
    if(gone||!window.location.hash)return;
    if(new URLSearchParams(window.location.hash.slice(1)).has('phone')){window.location.reload();return;}
    code=readInvitation();generation++;preview=null;existing=null;scanPending=true;message();show('pairLoading');nextScan();
  });
  window.addEventListener('pagehide', () => { gone=true; code=''; preview=null; });
  void inspect();
})();

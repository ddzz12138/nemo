import { phoneInvitationPath } from './phone-link-setup.js';

export function setupPhoneStart({document=globalThis.document,location=globalThis.location,connection=globalThis.NemoPhoneLink,confirm=globalThis.confirm}={}) {
  const form=document.getElementById('phoneInvitationForm'),status=document.getElementById('phoneStartStatus');
  form.addEventListener('submit',event=>{
    event.preventDefault();
    try {
      const destination=phoneInvitationPath(document.getElementById('phoneInvitation').value.trim(),location.origin);
      // The pairing screen checks the invitation and explicitly confirms a
      // profile switch. Pasting a link must not sign out an existing device.
      location.assign(destination);
    } catch { status.textContent='Paste the complete personal invitation link from this Nemo installation.'; }
  });
  if(connection?.ready)void connection.ready.then(()=>{
    if(connection.enabled){document.getElementById('resumePhone').hidden=new URLSearchParams(location.search).has('switch');document.getElementById('forgetPhone').hidden=false;}
  }).catch(error=>{status.textContent=error.message||'Phone storage is unavailable. Open Nemo in Safari outside private browsing.';});
  document.getElementById('forgetPhone').addEventListener('click',async()=>{
    if(!connection||!confirm('Forget this phone connection? Your saved chats remain on the host.'))return;
    try { await connection.forget();location.reload(); }
    catch { status.textContent='Nemo could not forget this connection. Please try again.'; }
  });
}

if(typeof document!=='undefined')setupPhoneStart();

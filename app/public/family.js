(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['status', 'profiles', 'createProfile', 'memberName', 'memberChildMode', 'invitePanel', 'inviteCode', 'inviteTitle', 'copyInvite', 'dismissInvite', 'pairLink', 'pageTitle'].map(id => [id, byId(id)]));
  let session; let busy = false;
  const toolLabels={memory:'Memory',gmail:'Gmail',calendar:'Calendar',reminders:'Leave reminders',research:'Web research',browser:'Browser',files:'Files and uploads',terminal:'Terminal and code',desktop:'Desktop',tasks:'Background tasks',agents:'Subagents',schedule:'Scheduling',voice:'Voice',media:'Images and video',extensions:'Skills and connections',models:'Model controls'};
  function say(text, error = false) { ui.status.textContent = text; ui.status.dataset.error = String(error); }
  function node(tag, text, className) { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; }
  async function api(path, input) {
    const response = await window.nemoFetch(path, { method: input ? 'POST' : 'GET', headers: input ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}, ...(input ? { body: JSON.stringify(input) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'This change could not be saved.'); return result;
  }
  async function perform(action) {
    if (busy) return; busy = true;
    for (const button of document.querySelectorAll('button:not([data-nemo-control]), input[type="checkbox"]')) button.disabled = true;
    try { say(''); await action(); await refresh(); }
    catch (error) { say(error.message, true); }
    finally { busy = false; for (const button of document.querySelectorAll('button:not([data-nemo-control]), input[type="checkbox"]')) button.disabled = false; }
  }
  function button(label, action) { const value = node('button', label); value.type = 'button'; value.addEventListener('click', () => void perform(action)); return value; }
  async function showInvite(profile) {
    const invitation = await api(`/api/profiles/${profile.id}/invites`, {});
    ui.inviteCode.textContent = invitation.code; ui.inviteTitle.textContent = `Invitation for ${profile.name}`; ui.invitePanel.hidden = false; ui.invitePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function refresh() {
    session = await api('/api/session');
    if (!session.authenticated) { ui.profiles.replaceChildren(); ui.createProfile.hidden = true; ui.invitePanel.hidden = true; ui.inviteCode.textContent = ''; ui.pairLink.hidden = false; throw new Error('Pair this device in chat to open your profile.'); }
    ui.pairLink.hidden = true;
    const owner = session.profile.role === 'owner'; ui.createProfile.hidden = !owner; ui.pageTitle.textContent = owner ? 'Your family.' : 'Your profile.';
    const profiles = owner ? (await api('/api/profiles')).profiles : [session.profile];
    const expanded=new Set([...ui.profiles.querySelectorAll('details[open][data-profile]')].map(node=>node.dataset.profile));
    ui.profiles.replaceChildren();
    for (const profile of profiles) {
      const card = node('section', '', 'profile-card'); card.append(node('h2', profile.name));
      card.append(node('p', profile.disabled ? 'Disabled · personal data is preserved.' : profile.role === 'owner' ? 'Server owner · your private profile' : 'Private family profile'));
      if (profile.role !== 'owner') card.append(node('p', profile.classification === 'adult' ? 'Adult · your own accounts and private memories.' : profile.classification === 'child' ? 'Child · restricted learning tools.' : 'Not classified · existing access is preserved.'));
      if (profile.childMode) card.append(node('p', 'Child mode · hints, explanations and feedback to help you learn. Homework stays your own work.'));
      if(profile.classification==='child')card.append(node('p',profile.parentalReview?'Family review is on. The owner can read this child’s chat history and personal Memory in the review screen.':'Family review is off.'));
      const actions = node('div', '', 'profile-actions');
      if (!profile.disabled) actions.append(button(profile.id === session.profile.id ? 'Add another device' : 'Create invitation', () => showInvite(profile)));
      actions.append(button('Rename', async () => { const value = window.prompt('Profile name', profile.name); if (value !== null) await api(`/api/profiles/${profile.id}/rename`, { name: value }); }));
      if (owner && profile.role !== 'owner') actions.append(button(profile.disabled ? 'Enable profile' : 'Disable profile', async () => { if (profile.disabled || window.confirm(`Disable ${profile.name}? Their devices will be signed out and their data will stay saved.`)) await api(`/api/profiles/${profile.id}/disabled`, { disabled: !profile.disabled }); }));
      if (owner && profile.role !== 'owner') {
        actions.append(button('Set as adult', async () => { if (window.confirm(`Classify ${profile.name} as an adult? This turns off Child mode. Additional PC tools still require verified isolation and setup.`)) await api(`/api/profiles/${profile.id}/classification`, { classification: 'adult' }); }));
        actions.append(button('Set as child', async () => { await api(`/api/profiles/${profile.id}/classification`, { classification: 'child' }); }));
        const label = node('label', '', 'child-mode-control');
        const control = node('input'); control.type = 'checkbox'; control.checked = profile.childMode;
        control.addEventListener('change', () => void perform(async () => { await api(`/api/profiles/${profile.id}/child-mode`, { enabled: control.checked }); }).then(() => { control.checked = profile.childMode; }));
        label.append(control, node('span', 'Child mode — help with learning, without completing homework.')); card.append(label);
      }
      if(owner&&profile.classification==='child'){
        const tools=node('details');tools.dataset.profile=profile.id;tools.open=expanded.has(profile.id);tools.append(node('summary','Choose tools for this child'));
        tools.append(node('p','Children start with chat only. Enabling a tool grants permission; tools that still need setup remain unavailable.'));
        for(const [capability,title]of Object.entries(toolLabels)){
          const label=node('label','','child-mode-control'),control=node('input');control.type='checkbox';control.checked=profile.capabilityGrants?.[capability]===true;
          control.addEventListener('change',()=>void perform(()=>api(`/api/profiles/${profile.id}/capabilities`,{capability,enabled:control.checked})));label.append(control,node('span',title));tools.append(label);
        }
        const reviewLabel=node('label','','child-mode-control'),reviewControl=node('input');reviewControl.type='checkbox';reviewControl.checked=profile.parentalReview;
        reviewControl.addEventListener('change',()=>void perform(()=>api(`/api/profiles/${profile.id}/parental-review`,{enabled:reviewControl.checked})));reviewLabel.append(reviewControl,node('span','Visible parental review of History and Memory'));tools.append(reviewLabel);card.append(tools);
        if(profile.parentalReview){const link=node('a','Review History & Memory ↗');link.href='/family-review.html?child='+encodeURIComponent(profile.id);actions.append(link);}
      }
      card.append(actions);
      const devices = (await api(`/api/profiles/${profile.id}/devices`)).devices;
      const active = devices.filter(device => !device.revokedAt && device.expiresAt > Date.now());
      if (!active.length) card.append(node('p', 'No paired devices yet. Create an invitation to get started.'));
      for (const device of active) {
        const row = node('div', '', 'profile-card'); row.append(node('h3', `${device.name}${device.id === session.device.id ? ' · this device' : ''}`));
        row.append(node('p', `Signed in until ${new Date(device.expiresAt).toLocaleDateString()}`));
        const revoke = node('div', '', 'profile-actions'); revoke.append(button('Sign out device', async () => { if (!window.confirm('Sign out this device? The profile and its data will stay saved.')) return; await api(`/api/devices/${device.id}/revoke`, {}); if (device.id === session.device.id) window.location.assign('/'); })); row.append(revoke); card.append(row);
      }
      ui.profiles.append(card);
    }
    if(session.profile.classification==='child'){
      const audit=await api('/api/family/review-log');const section=node('section','','profile-card');section.append(node('h2','Family review activity'));
      if(!audit.events.length)section.append(node('p','No reviews recorded yet.'));
      for(const event of audit.events.slice(0,10))section.append(node('p',`${event.reviewer} viewed ${event.kind==='memory'?'personal Memory':'chat history'} · ${new Date(event.at).toLocaleString()}`));ui.profiles.append(section);
    }
  }
  ui.createProfile.addEventListener('submit', event => { event.preventDefault(); void perform(async () => { const result = await api('/api/profiles', { name: ui.memberName.value, childMode: ui.memberChildMode.checked }); ui.memberName.value = ''; ui.memberChildMode.checked = false; await showInvite(result.profile); }); });
  ui.copyInvite.addEventListener('click', () => { void navigator.clipboard.writeText(ui.inviteCode.textContent).then(() => say('Invitation copied. Share it privately.'), () => say('Select and copy the invitation code.', true)); });
  ui.dismissInvite.addEventListener('click', () => { ui.invitePanel.hidden = true; ui.inviteCode.textContent = ''; });
  void refresh().catch(error => say(error.message, true));
})();

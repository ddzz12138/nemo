(() => {
  'use strict';
  const $ = id => document.getElementById(id), status = $('passkeyStatus'); let busy = false, configured=true;
  const usable=!!window.PublicKeyCredential&&!!window.SimpleWebAuthnBrowser&&window.isSecureContext;
  function updateButtons(){for(const button of document.querySelectorAll('button:not([data-nemo-control])'))button.disabled=busy||['signInPasskey','addPasskey'].includes(button.id)&&!usable||button.id==='addPasskey'&&!configured;}
  function say(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  async function api(path, input) {
    const response = await window.nemoFetch(path, { ...(input !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, body: JSON.stringify(input) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Nemo could not complete that sign-in.'); return result;
  }
  async function perform(action) {
    if (busy) return; busy = true; for (const node of document.querySelectorAll('button:not([data-nemo-control])')) node.disabled = true;
    try { say(''); await action(); } catch (error) { say(error.name === 'NotAllowedError' ? 'Passkey request cancelled. You can try again or use a personal invitation.' : error.message || 'This device could not use the passkey.', true); }
    finally { busy = false; updateButtons(); }
  }
  async function refresh() {
    const session = await api('/api/session');
    if ($('signInPasskey')) {
      $('signInPasskey').hidden = session.authenticated; $('switchPerson').hidden = !session.authenticated; $('continueChat').hidden = !session.authenticated;
      if (session.authenticated) say(`You are signed in as ${session.profile.name}. Sign out before switching people.`);
      return;
    }
    if (!session.authenticated) { window.location.replace('/sign-in.html'); return; }
    const result = await api('/api/passkeys'), fragment = document.createDocumentFragment();
    for (const key of result.passkeys) {
      const card = document.createElement('section'); card.className = 'profile-card'; const title = document.createElement('h2'); title.textContent = key.name;
      const detail = document.createElement('p'); detail.textContent = `Added ${new Date(key.createdAt).toLocaleDateString()}${key.lastUsedAt ? ' · Last used ' + new Date(key.lastUsedAt).toLocaleDateString() : ''}`;
      const actions = document.createElement('div'); actions.className = 'profile-actions'; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove passkey';
      remove.addEventListener('click', () => void perform(async () => { if (!window.confirm(`Remove “${key.name}”? Devices signed in with it will be signed out. Your data stays saved.`)) return; const removed = await api('/api/passkeys/remove', { id: key.id }); if (removed.signedOut) window.location.replace('/sign-in.html'); else { await refresh(); say('Passkey removed. Your data is preserved.'); } }));
      actions.append(remove); card.append(title, detail, actions); fragment.append(card);
    }
    if (!result.passkeys.length) { const empty = document.createElement('p'); empty.textContent = 'No passkeys yet. Add one to make returning easier.'; fragment.append(empty); }
    $('passkeyList').replaceChildren(fragment);
    configured=result.configured;updateButtons();
    if (!configured) say('Ask the host to configure the private HTTPS address before adding passkeys.', true);
  }
  $('signInPasskey')?.addEventListener('click', () => void perform(async () => { const { options } = await api('/api/passkeys/authentication/options', {}); const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options }); await api('/api/passkeys/authentication/verify', { response, deviceName: 'Passkey browser' }); window.location.replace('/'); }));
  $('addPasskey')?.addEventListener('click', () => void perform(async () => { const { options } = await api('/api/passkeys/registration/options', {}); const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options }); await api('/api/passkeys/registration/verify', { response, label: $('passkeyLabel').value.trim() || 'Personal passkey' }); await refresh(); say('Passkey saved for your profile.'); }));
  $('switchPerson')?.addEventListener('click', () => void perform(async () => { await api('/api/logout', {}); window.location.reload(); }));
  if (!usable) { say('Passkeys need a supported browser at Nemo’s private HTTPS address. You can still use a personal invitation.', true);updateButtons(); }
  void refresh().catch(error => say(error.message, true));
})();

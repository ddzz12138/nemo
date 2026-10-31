export function createGmailConnectionApp({ document, fetchImpl = (...args) => window.nemoFetch(...args), navigate = url => { window.location.assign(url); } }) {
  const ids = ['status','accountPanel','account','connectionForm','choices','syncChoice','demandChoice','continueButton','continueHelp','setupPanel','callbackAddress','storedPanel','syncSummary','syncNow','viewCache','clearCache','cacheList','managePanel','switchAccount','disconnect','pairLink'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  let state = null;
  let busy = false;
  function say(text, kind = '') { ui.status.textContent = text; ui.status.dataset.kind = kind; ui.status.hidden = !text; }
  const chosen = () => ui.syncChoice.checked ? 'sync' : 'demand';
  async function api(path, body) {
    const response = await fetchImpl(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data;
    try { data = await response.json(); } catch { throw new Error('The PC returned an unreadable response. Try reloading Nemo.'); }
    if (response.status === 401) { state = null; ui.pairLink.hidden = false; render(); throw new Error('Pair this browser with your PC in Nemo, then reopen Gmail.'); }
    if (!response.ok) throw new Error(data.error || 'Gmail could not be updated. Try again.');
    return data;
  }
  function render() {
    const connected = state?.gmail.connected === true;
    const sync = state?.sync;
    const phone = state?.phone.available === true;
    ui.choices.disabled = busy || !state;
    ui.continueButton.disabled = busy || !state || (!connected && !phone);
    ui.continueButton.textContent = busy ? 'Please wait…' : connected ? 'Save connection type' : 'Continue with Google';
    ui.accountPanel.hidden = !connected;
    ui.account.textContent = connected ? state.gmail.account || 'Your authorized Google account' : '';
    ui.setupPanel.hidden = !state || phone || !!state.phone.reason;
    ui.callbackAddress.textContent = state?.phone.redirectUri || '';
    ui.managePanel.hidden = !connected;
    ui.storedPanel.hidden = !connected;
    ui.switchAccount.disabled = busy || !phone;
    ui.disconnect.disabled = busy;
    for (const id of ['syncNow','viewCache','clearCache']) ui[id].disabled = busy || !connected || (id === 'syncNow' && sync?.mode !== 'sync');
    if (sync) {
      const date = sync.lastSyncedAt ? new Intl.DateTimeFormat(undefined, {dateStyle:'medium',timeStyle:'short'}).format(new Date(sync.lastSyncedAt)) : 'not yet';
      ui.syncSummary.textContent = sync.mode === 'sync' ? `${sync.count} of up to 50 snippets saved. Last sync: ${date}.${state.syncing ? ' Sync in progress.' : sync.stale ? ' A refresh is due.' : ''}` : 'No Gmail snippets are saved here. Nemo searches Google when you ask.';
    }
    ui.continueHelp.textContent = state?.phone.reason || (connected ? 'This changes local caching. It does not change your AI sharing preference.' : 'Sign in securely with Google. Your password stays with Google.');
  }
  async function refresh({ resetChoice = false } = {}) {
    const next = await api('/api/gmail/connection');
    state = next;
    if (resetChoice && next.gmail.connected) {
      ui.syncChoice.checked = next.sync.mode === 'sync';
      ui.demandChoice.checked = next.sync.mode !== 'sync';
    }
    render();
    return next;
  }
  async function perform(action) {
    if (busy) return;
    busy = true; render();
    try { await action(); } catch (error) { say(error.message || 'The computer could not be reached. Keep Nemo running on it, check phone access and try again.', 'error'); }
    finally { busy = false; render(); }
  }
  async function authorize() {
    const data = await api('/api/gmail/oauth/start', { mode: chosen() });
    // This allowlist also prevents a malformed server response from becoming an
    // arbitrary navigation. Tokens and client secrets never reach this page.
    const url = new URL(data.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Google sign-in returned an unexpected address.');
    navigate(url.href);
  }
  ui.connectionForm.addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      if (!state?.gmail.connected) return authorize();
      await api('/api/gmail/mode', { mode: chosen() });
      ui.cacheList.replaceChildren(); ui.cacheList.hidden = true;
      say(chosen() === 'sync' ? 'Sync enabled. Nemo is fetching up to 50 recent snippets. Your AI sharing preference is unchanged.' : 'Sync stopped and the local Gmail cache cleared. Original emails are unchanged.', 'success');
      await refresh();
    });
  });
  ui.switchAccount.addEventListener('click', () => void perform(authorize));
  ui.syncNow.addEventListener('click', () => void perform(async () => { await api('/api/gmail/sync', {}); say('Refreshing recent snippets. Original emails are unchanged.', 'success'); await refresh(); }));
  ui.clearCache.addEventListener('click', () => void perform(async () => {
    await api('/api/gmail/cache/clear', {});
    ui.cacheList.replaceChildren(); ui.cacheList.hidden = true;
    await refresh({ resetChoice: true });
    say('Local cache cleared and automatic sync stopped. Earlier chat and backup copies are outside this deletion.', 'success');
  }));
  ui.viewCache.addEventListener('click', () => void perform(async () => {
    const data = await api('/api/gmail/cache');
    ui.cacheList.replaceChildren();
    for (const item of data.messages || []) {
      const card = document.createElement('article');
      const title = document.createElement('h3'); title.textContent = item.subject || '(No subject)';
      const sender = document.createElement('p'); sender.textContent = `${item.from || 'Unknown sender'} · ${item.date || 'Date unavailable'}`;
      const snippet = document.createElement('p'); snippet.textContent = item.snippet || '(No snippet)';
      card.append(title, sender, snippet); ui.cacheList.append(card);
    }
    ui.cacheList.hidden = false;
    if (!data.messages?.length) say('No Gmail snippets are stored on this PC.', 'success');
  }));
  ui.disconnect.addEventListener('click', () => void perform(async () => {
    const data = await api('/api/gmail/disconnect', {});
    ui.cacheList.replaceChildren(); ui.cacheList.hidden = true;
    await refresh({ resetChoice: true });
    say(data.warning || 'Gmail disconnected. Local tokens and the email cache were removed. Original emails are unchanged.', data.warning ? 'error' : 'success');
  }));
  return {
    async start(result = '') {
      await perform(async () => {
        await refresh({ resetChoice: true });
        const messages = { connected: 'Gmail connected with read-only access. Your connection type has been saved.', denied: 'Google access was cancelled. Your previous connection is unchanged.', expired: 'That sign-in expired or the browser was unpaired. Start again here.', failed: 'Google sign-in did not finish. Check the connection shown below before trying again.', browser: 'Google returned to a different browser or an expired sign-in. Pair Nemo in Safari if needed, then start Google sign-in again here.' };
        if (messages[result]) say(messages[result], result === 'connected' ? 'success' : 'error');
        else say(state.gmail.connected ? 'Choose how Nemo reads your inbox. You can change this anytime.' : state.phone.available ? '' : 'Phone sign-in needs a Google Web client. Follow the PC setup below.');
      });
    },
    refresh,
  };
}

if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('gmail') || '';
  window.history.replaceState(null, '', window.location.pathname);
  const app = createGmailConnectionApp({ document });
  void app.start(result);
  window.addEventListener('pageshow', event => { if (event.persisted) void app.start(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') document.getElementById('cacheList').replaceChildren(); });
}

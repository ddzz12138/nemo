/* A stale tab must never submit a previous person's draft as the new person. */
(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  let profile = null; let epoch = 0; let loading = null;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('nemo.identity.v2') : null;
  function clearBrowserState() { for (const name of ['sessionStorage','localStorage']) { try { const store = window[name]; for (const key of Object.keys(store)) if (key.startsWith('nemo.') && key !== 'nemo.phone.active.v1') store.removeItem(key); } catch {} } }
  channel?.addEventListener('message', event => { if(event?.data?.transportSource&&event.data.transportSource===window.NemoPhoneLink?.windowId)return;epoch++;clearBrowserState(); document.body.replaceChildren(); window.location.reload(); });
  function update(next, broadcast = false) {
    const changed = profile?.id !== next?.id;
    if (changed) { epoch++; if (profile) clearBrowserState(); }
    profile = next || null;
    for (const node of document.querySelectorAll('[data-profile-name]')) node.textContent = profile?.name || 'Profile';
    for (const node of document.querySelectorAll('[data-child-mode]')) node.hidden = !profile?.childMode;
    let review=document.getElementById('nemoReviewNotice');
    if(profile?.parentalReview){if(!review){review=document.createElement('aside');review.id='nemoReviewNotice';review.className='family-review-notice';review.setAttribute('aria-label','Family review');(document.querySelector?.('.app-shell')||document.body).prepend(review);}review.replaceChildren();const text=document.createElement('span');text.textContent='Family review is on. Your family owner can read your chats and personal Memory. ';const link=document.createElement('a');link.href='/family.html';link.textContent='See review activity';review.append(text,link);}else review?.remove();
    if (broadcast && changed) channel?.postMessage({ changed: true, ...(window.NemoPhoneLink?.windowId ? { transportSource: window.NemoPhoneLink.windowId } : {}) });
  }
  async function load() {
    if (!loading) { const version = epoch; loading = nativeFetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(async response => { const value = await response.json(); if (version !== epoch) throw new Error('The signed-in profile changed. Reload Nemo.'); update(value.profile); return value; }).finally(() => { loading = null; }); }
    return loading;
  }
  window.NemoIdentity = { load, get profile() { return profile; }, get epoch() { return epoch; } };
  window.nemoFetch = async (path, options = {}) => {
    const publicRoute = ['/api/pair', '/api/session', '/api/passkeys/authentication/options', '/api/passkeys/authentication/verify'].includes(path);
    if (!publicRoute && !profile) await load();
    const expected = profile?.id; const version = epoch;
    const headers = new Headers(options.headers || {});
    if (expected && !publicRoute) {
      if (headers.has('X-Nemo-Profile') && headers.get('X-Nemo-Profile') !== expected) throw new Error('The signed-in profile changed. Reload Nemo.');
      headers.set('X-Nemo-Profile', expected);
    }
    const response = await nativeFetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers });
    if (version !== epoch) throw new Error('The signed-in profile changed. Reload Nemo.');
    if (path === '/api/session' || (['/api/pair', '/api/passkeys/authentication/verify'].includes(path) && response.ok)) { const value = await response.clone().json(); update(value.profile, path !== '/api/session'); }
    if ((path === '/api/logout' && response.ok) || response.status === 401) update(null, true);
    return response;
  };
})();

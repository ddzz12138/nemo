// The interface owns presentation; the existing server owns identity and tools.
const PUBLIC = new Set(['/api/session', '/api/pair', '/api/pair/preview']);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function createDesktopApi({ fetchImpl, getProfile, getEpoch = () => 0 }) {
  async function request(path, input) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || /[#\\\s]/.test(path)) throw new Error('Choose a Nemo action.');
    if (path.includes('?')) {
      const parsed = new URL(path, 'http://nemo.local'), keys = [...parsed.searchParams.keys()], id = parsed.searchParams.get('id');
      if (parsed.pathname !== '/api/memory/fact' || keys.length !== 1 || keys[0] !== 'id' || !id || id.length > 512 || /[\\\s]/.test(id) || path.length > 2048) throw new Error('Choose a Nemo action.');
    }
    const profile = getProfile(), epoch = getEpoch(), publicRequest = PUBLIC.has(path);
    if (!publicRequest && !profile?.id) throw Object.assign(new Error('Connect your own Nemo profile first.'), { status: 401 });
    const controller = new AbortController();
    const memoryWrite = input !== undefined && /^\/api\/memory\/(?:enable|notes|edit|delete|learning)(?:\/|$)/.test(path);
    const timer = setTimeout(() => controller.abort(), memoryWrite ? 180_000 : 15_000);
    try {
      const response = await fetchImpl(path, {
        method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(!publicRequest ? { 'X-Nemo-Profile': profile.id } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json', 'X-Nemo-Request': '1' } : {}) },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      });
      const data = await response.json();
      // nemoFetch deliberately clears the identity/epoch after a successful
      // logout. Return only a public acknowledgement for that intended change.
      if (path === '/api/logout' && response.ok) return { ok: true };
      if (!publicRequest && (getProfile()?.id !== profile.id || getEpoch() !== epoch)) throw Object.assign(new Error('The signed-in person changed. Reopen Nemo before continuing.'), { code: 'PROFILE_CHANGED', status: 409 });
      if (!response.ok) throw Object.assign(new Error(data.error || 'Nemo could not complete this request.'), { status: response.status, code: data.code || '' });
      return data;
    } finally { clearTimeout(timer); }
  }
  const identified = id => { if (!ID.test(id || '')) throw new Error('Choose a saved Nemo conversation.'); return id; };
  return {
    request,
    session: () => request('/api/session'),
    conversation: () => request('/api/conversation'),
    history: () => request('/api/history'),
    savedConversation: id => request('/api/history/' + identified(id)),
    newConversation: fromConversationId => request('/api/conversations/new', { fromConversationId: identified(fromConversationId) }),
    openConversation: (conversationId, fromConversationId) => request('/api/conversations/open', { conversationId: identified(conversationId), fromConversationId: identified(fromConversationId) }),
    run: id => request('/api/runs/' + identified(id)),
    send: (message, requestId, conversationId, workflow) => request('/api/chat', { message, requestId: identified(requestId), ...(conversationId ? { conversationId: identified(conversationId) } : {}), ...(workflow ? { workflow } : {}) }),
    integrations: () => request('/api/integrations'),
    consent: enabled => request('/api/integrations/consent', { enabled: enabled === true }),
    gmail: () => request('/api/gmail/connection'),
    disconnectGmail: () => request('/api/gmail/disconnect', {}),
  };
}

export function activityLabel(activity) {
  const events = Array.isArray(activity?.entries) ? activity.entries : [];
  const current = [...events].reverse().find(event => event.state === 'running' || event.state === 'queued');
  return current?.label || activity?.summary || 'Preparing your reply';
}

// Identity checks alone do not order two reads for the same person. A send or
// newer refresh invalidates older conversation snapshots before they can render.
export function createViewGate() {
  let revision = 0;
  return { begin: () => ++revision, current: value => value === revision };
}

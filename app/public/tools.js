(() => {
  'use strict';
  const list = document.getElementById('toolsList');
  const status = document.getElementById('toolsStatus');
  const labels = { ready: 'Ready', needs_setup: 'Needs setup', disabled: 'Disabled', unavailable: 'Unavailable', degraded: 'Degraded' };
  async function load() {
    const response = await window.nemoFetch('/api/capabilities');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Pair this device to see your tools.');
    list.replaceChildren();
    const more = document.createElement('details'); more.className = 'profile-card';
    const summary = document.createElement('summary'); summary.textContent = 'More Hermes tools'; more.append(summary);
    const note = document.createElement('p'); note.textContent = 'These tools need a later runtime update and setup. Your current connections continue to work.'; more.append(note);
    for (const tool of result.capabilities) {
      const card = document.createElement('section'); card.className = 'profile-card';
      const heading = document.createElement('h2'); heading.textContent = tool.title;
      const state = document.createElement('strong'); state.textContent = labels[tool.state] || 'Unavailable';
      const reason = document.createElement('p'); reason.textContent = tool.reason;
      card.append(heading, state, reason);
      if (typeof tool.setup === 'string' && /^\/[a-z-]+\.html$/.test(tool.setup)) { const link = document.createElement('a'); link.href = tool.setup; link.textContent = 'Open ↗'; card.append(link); }
      (tool.group === 'more' ? more : list).append(card);
    }
    list.append(more);
  }
  void load().catch(error => { list.replaceChildren(); status.textContent = error.message; });
})();

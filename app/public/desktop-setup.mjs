// Shared by the desktop renderer and the local CLI setup page. Credentials stay
// in the main process; only the CLI page holds its launch capability in memory.
export const SETUP_ACTIONS = Object.freeze({ status: ['GET', '/api/setup/status'], owner: ['POST', '/api/setup/owner'], runtime: ['POST', '/api/setup/runtime'], assistant: ['POST', '/api/setup/assistant'], enroll: ['POST', '/api/setup/enroll'], enrollment: ['POST', '/api/setup/enroll/poll'], enable: ['POST', '/api/setup/remote/enable'], disable: ['POST', '/api/setup/remote/disable'], invite: ['POST', '/api/setup/invite'], localInvite: ['POST', '/api/setup/local-invite'] });

export function setupState(status) {
  if (!status) return 'loading';
  if (!status.owner?.configured && (!status.owner?.name || status.owner.name === 'Owner')) return 'name';
  if (status.runtime?.ready !== true) return 'runtime';
  const assistant = status.assistant || status.runtime?.assistant;
  if (!status.app?.ready || status.runtime?.connected === false || status.app?.assistantConnected === false ||
      assistant && (assistant.connected !== true || assistant.phase !== 'connected' || assistant.provider === 'chatgpt' && assistant.planUsageEnabled !== true)) return 'assistant';
  return 'ready';
}

export function canOpenPersonalSpace(status) {
  const assistant = status?.assistant || status?.runtime?.assistant;
  const confirmation = assistant?.connected === true && (assistant.confirmationRequired === true || assistant.planUsageAcknowledged === false);
  if (confirmation) return false;
  return status?.setupCompleted === true && status.app?.ready === true || setupState(status) === 'ready' && assistant?.confirmationRequired !== true && assistant?.planUsageAcknowledged !== false;
}

export function setupMessage(error) {
  const text = String(error?.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  if (/\b(?:ENOENT|EACCES|stack|node_modules|NEMO_[A-Z_]+)\b|[A-Z]:\\|\/Users\/|\/home\//.test(text)) return 'Nemo could not finish this step. Reopen the app and try again. Your chats are saved.';
  return text || 'Nemo could not finish this step. Please try again.';
}

export function createSetupClient({ desktop, fetchImpl = fetch, location, history, getProfileId = () => undefined }) {
  let capability = '';
  if (!desktop) capability = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  return {
    async request(action, input = {}) {
      if (desktop) return desktop.request(action, input, getProfileId());
      const route = Object.hasOwn(SETUP_ACTIONS, action) ? SETUP_ACTIONS[action] : null;
      if (!route || !capability) throw new Error('Open Nemo on this computer to continue setup.');
      const response = await fetchImpl(route[1], { method: route[0], redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000), headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json', 'X-Nemo-Request': '1' }, ...(route[0] === 'POST' ? { body: JSON.stringify(input) } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Nemo could not finish this step.');
      return data;
    },
    dispose() { capability = ''; },
  };
}

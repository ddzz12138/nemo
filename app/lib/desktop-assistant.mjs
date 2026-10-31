import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './profile-store.mjs';
import { createAssistantOnboarding } from './assistant-onboarding.mjs';
import { checkLocalOllama, LOCAL_OLLAMA } from './local-ollama.mjs';
import { mkdir } from 'node:fs/promises';

export async function readAssistantSelection(dataDir) {
  const saved = await readJson(join(dataDir, 'assistant-mode.json'), null);
  if (saved && (saved.version !== 1 || !['local', 'chatgpt'].includes(saved.provider))) throw new Error('Nemo could not read the selected assistant.');
  return saved;
}
export async function selectLocalAssistant(dataDir) {
  await mkdir(dataDir, { recursive: true });
  await writeJson(join(dataDir, 'assistant-mode.json'), { version: 1, provider: 'local' });
}

/** Local mode never opens protected ChatGPT storage or starts its onboarding.
 * Existing cloud installations retain their route until the host selects local. */
export async function createDesktopAssistant({ dataDir, onConnectionChanging = async () => {}, onConnected = async () => {}, cloudFactory = createAssistantOnboarding, localCheck = checkLocalOllama, ...options } = {}) {
  const path = join(dataDir, 'assistant-mode.json');
  const saved = await readAssistantSelection(dataDir);
  const legacy = existsSync(join(dataDir, 'assistant-provider.dpapi')) || (await readJson(join(dataDir, 'host-setup.json'), null))?.completed === true;
  let provider = saved?.provider || (legacy ? 'chatgpt' : 'local'), cloud, closed = false, chain = Promise.resolve();
  let local = { connected: false, message: 'Check Ollama on this PC to connect Gemma 4 12B.' };
  const serialize = work => { const next = chain.catch(() => {}).then(work); chain = next.then(() => {}, () => {}); return next; };
  async function getCloud() {
    if (!cloud) cloud = await cloudFactory({ dataDir, onConnectionChanging, onConnected, ...options });
    return cloud;
  }
  async function check() { local = await localCheck(); return status(); }
  function status() {
    if (provider === 'chatgpt') return cloud?.status() || { provider: 'chatgpt', connected: false, phase: 'disconnected', message: 'Connect your ChatGPT plan or choose local Gemma.' };
    return { provider: 'ollama', localOnly: true, connected: local.connected === true, phase: local.connected ? 'connected' : 'unavailable', model: LOCAL_OLLAMA.model,
      message: local.connected ? 'Gemma 4 12B is available on this PC. Replies stay local.' : local.message,
      planUsageEnabled: false, planUsageAcknowledged: true, confirmationRequired: false };
  }
  async function select(next) {
    if (closed) throw new Error('Nemo is closing.');
    if (provider === next) return;
    if (next === 'chatgpt') await getCloud();
    await onConnectionChanging();
    // Persist the deliberate selection even when the selected backend is down.
    // A local failure must never reactivate an old cloud account implicitly.
    await writeJson(path, { version: 1, provider: next }); provider = next;
    if (next === 'local' && cloud) { await cloud.close(); cloud = null; }
    await onConnected({ localOnly: provider === 'local' }); return true;
  }
  if (provider === 'local') { if (!saved) await selectLocalAssistant(dataDir); await check(); } else { try { await getCloud(); } catch { /* Local selection remains usable if protected cloud storage cannot open. */ } }
  return {
    status, localModel: () => provider === 'local' ? LOCAL_OLLAMA : null,
    credentials: () => provider === 'chatgpt' ? getCloud().then(item => item.credentials()) : Promise.resolve(null),
    reportInferenceFailure: code => provider === 'chatgpt' ? cloud?.reportInferenceFailure?.(code) : undefined,
    begin(input = {}) { return serialize(async () => {
      if (closed) throw new Error('Nemo is closing.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose an assistant in Nemo setup.');
      const { provider: chosen, ...action } = input;
      if (chosen !== undefined && !['local', 'chatgpt'].includes(chosen)) throw new Error('Choose an assistant in Nemo setup.');
      if (chosen === 'local' || !chosen && provider === 'local') {
        if (Object.keys(action).some(key => key !== 'retry')) throw new Error('Choose an assistant in Nemo setup.');
        await check(); const changed = await select('local');
        if (!changed) await onConnected({ localOnly: true });
        return status();
      }
      await select('chatgpt'); const selected = await getCloud();
      return !Object.keys(action).length && selected.status().connected ? selected.retryConnection() : selected.begin(action);
    }); },
    retryConnection() { return serialize(async () => { if (closed) throw new Error('Nemo is closing.'); if (provider === 'chatgpt') return (await getCloud()).retryConnection(); await check(); await onConnected({ localOnly: true }); return status(); }); },
    async close() { closed = true; await chain; await cloud?.close(); },
  };
}

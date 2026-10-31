import { join } from 'node:path';
import { readJson, writeJson } from './profile-store.mjs';
import { createAssistantOnboarding } from './assistant-onboarding.mjs';

export async function readAssistantSelection(dataDir) {
  const saved = await readJson(join(dataDir, 'assistant-mode.json'), null);
  // Recognize the old local choice only to require deliberate cloud consent.
  if (saved && (saved.version !== 1 || !['local', 'chatgpt'].includes(saved.provider))) throw new Error('Nemo could not read the selected assistant.');
  return saved;
}

/** Public v1 uses a ChatGPT subscription. It never probes or launches a local
 * model. Preserve existing grants; a previous local choice must explicitly opt
 * into ChatGPT before even opening protected account storage. */
export async function createDesktopAssistant({ dataDir, onConnectionChanging = async () => {}, onConnected = async () => {}, cloudFactory = createAssistantOnboarding, ...options } = {}) {
  let approved = (await readAssistantSelection(dataDir))?.provider !== 'local';
  let cloud, closed = false, chain = Promise.resolve();
  const serialize = work => { const next = chain.catch(() => {}).then(work); chain = next.then(() => {}, () => {}); return next; };
  async function getCloud() {
    if (!cloud) cloud = await cloudFactory({ dataDir, onConnectionChanging, onConnected, ...options });
    return cloud;
  }
  function status() {
    return cloud?.status() || { provider: 'chatgpt', connected: false, phase: 'disconnected', planUsageEnabled: false,
      message: approved ? 'Connect your ChatGPT subscription to use Nemo.' : 'This version uses your ChatGPT subscription. Choose Continue with ChatGPT to connect. Your saved data is preserved.' };
  }
  if (approved) { try { await getCloud(); } catch { /* Setup can offer a safe retry if protected storage is unavailable. */ } }
  return {
    status,
    credentials: () => approved && !closed ? getCloud().then(item => item.credentials()) : Promise.resolve(null),
    reportInferenceFailure: code => cloud?.reportInferenceFailure?.(code),
    begin(input = {}) { return serialize(async () => {
      if (closed) throw new Error('Nemo is closing.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Connect your ChatGPT subscription in Nemo setup.');
      const { provider, ...action } = input;
      if (provider !== undefined && provider !== 'chatgpt') throw new Error('This version of Nemo requires a ChatGPT subscription. Local models are not supported.');
      if (!approved) {
        if (provider !== 'chatgpt') throw new Error('Choose Continue with ChatGPT before connecting.');
        await onConnectionChanging();
        await writeJson(join(dataDir, 'assistant-mode.json'), { version: 1, provider: 'chatgpt' });
        approved = true;
      }
      const selected = await getCloud();
      return !Object.keys(action).length && selected.status().connected ? selected.retryConnection() : selected.begin(action);
    }); },
    retryConnection() { return serialize(async () => {
      if (closed) throw new Error('Nemo is closing.');
      if (!approved) throw new Error('Choose Continue with ChatGPT before connecting.');
      return (await getCloud()).retryConnection();
    }); },
    async close() { closed = true; await chain; await cloud?.close(); },
  };
}

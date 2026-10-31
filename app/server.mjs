import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFamilyServer } from './lib/family-server.mjs';
import { loadConfig } from './lib/config.mjs';
import { createPhoneLink } from './lib/phone-link.mjs';
import { createDesktopAssistant } from './lib/desktop-assistant.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
export async function createNemoServer(options = {}) {
  const config = await loadConfig({ ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const hermesOptions = { ...(config.hermesLauncher ? { launcher: config.hermesLauncher } : {}), ...(config.hermesHome ? { hermesHome: config.hermesHome } : {}), hermesPython: config.hermesPython, hermesSource: config.hermesSource };
  let assistant;
  // Explicit provider injection is the integration-test seam. Normal CLI and
  // desktop launches must not inherit Hermes' model/API-key/fallback settings.
  if (!options.provider) {
    const selected = options.hermesOptions || {};
    if (selected.localModel || selected.providerKey || selected.requireChatGPT === false || options.nativeFactory || options.memoryFactory) throw new Error('This release supports only a ChatGPT subscription. Local-model features are not available.');
    if (!selected.chatgptSession) assistant = await createDesktopAssistant({ dataDir: config.dataDir, openExternal: async () => { throw new Error('Connect your ChatGPT subscription in Nemo desktop setup.'); } });
    Object.assign(hermesOptions, selected, { requireChatGPT: true,
      chatgptSession: selected.chatgptSession || (() => assistant.credentials()),
      chatgptStatus: selected.chatgptStatus || (() => assistant?.status() || { connected: false, planUsageEnabled: false }),
      onChatGPTFailure: selected.onChatGPTFailure || (code => assistant?.reportInferenceFailure(code)) });
  }
  try {
    const app = await createFamilyServer({ dataDir: config.dataDir, publicOrigin: config.publicOrigin, phoneLinkFactory: createPhoneLink, publicDir: join(ROOT, 'public'), ...options,
      hermesOptions, nativeFactory: options.provider ? options.nativeFactory : null, memoryFactory: options.provider ? options.memoryFactory : null });
    const close = app.close;
    app.close = async () => { try { await close(); } finally { await assistant?.close(); } };
    return app;
  } catch (error) { await assistant?.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { port } = await loadConfig();
  const app = await createNemoServer();
  let stopping = false;
  const stop = (code = 0) => { if(stopping)return;stopping=true;void app.close().then(() => process.exit(code), () => process.exit(1)); };
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Nemo’s port is already in use.' : 'Nemo could not start.'); stop(1); });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Nemo family profiles are running on http://127.0.0.1:${port}`);
    console.log('Create a personal owner invitation locally: nemo invite');
    console.log('Read-only tools follow each profile’s saved Connections permission.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
  process.on('message', message => { if(message?.type === 'nemo:stop')stop(); });
}

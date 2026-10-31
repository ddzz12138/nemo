import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFamilyServer } from './lib/family-server.mjs';
import { createProfileMemory } from './lib/profile-memory.mjs';
import { loadConfig } from './lib/config.mjs';
import { loadNativeSettings,createNativeChat } from './lib/native-chat.mjs';
import { createPhoneLink } from './lib/phone-link.mjs';
import { readAssistantSelection } from './lib/desktop-assistant.mjs';
import { checkLocalOllama, LOCAL_OLLAMA } from './lib/local-ollama.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
export async function createNemoServer(options = {}) {
  const config = await loadConfig({ ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
  const hermesOptions = { ...(config.hermesLauncher ? { launcher: config.hermesLauncher } : {}), ...(config.hermesHome ? { hermesHome: config.hermesHome } : {}), hermesPython: config.hermesPython, hermesSource: config.hermesSource };
  const local = (await readAssistantSelection(config.dataDir))?.provider === 'local';
  if (local) { const status = await checkLocalOllama(); Object.assign(hermesOptions, { localModel: LOCAL_OLLAMA, localStatus: () => status }); }
  const nativeFactory=async context=>{const settings=await loadNativeSettings(config.dataDir);return settings.enabled?createNativeChat({...context,...settings}):null;};
  return createFamilyServer({ dataDir: config.dataDir, publicOrigin: config.publicOrigin, hermesOptions, nativeFactory: local ? null : nativeFactory, phoneLinkFactory: createPhoneLink, publicDir: join(ROOT, 'public'), memoryFactory: createProfileMemory, ...options });
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

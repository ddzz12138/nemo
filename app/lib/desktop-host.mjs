import { join } from 'node:path';
import { loadConfig, saveConfig, APP_ROOT } from './config.mjs';
import { createProfileStore } from './profile-store.mjs';
import { createNemoServer } from '../server.mjs';
import { createSetupRuntime } from './setup-runtime.mjs';
import { createDesktopAssistant } from './desktop-assistant.mjs';
import { createRemoteHost } from './remote-host.mjs';
import { createRemoteCloudClient, boundedText } from './remote-host-cloud-client.mjs';
import { createCloudflaredConnector } from './remote-host-connector.mjs';
import { createHostSetupServer } from './host-setup-server.mjs';
import { createProcessControl } from './managed-process.mjs';
import { ensureGmailPublisherClient } from './gmail-publisher.mjs';

export async function verifyRemoteInstallation({ publicOrigin, installationId, challenge }, { fetchImpl = fetch } = {}) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !/^[a-f0-9]{32,128}$/.test(challenge)) return false;
  const response = await fetchImpl(`${origin.origin}/.well-known/nemo-host?challenge=${challenge}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) return false;
  const proof = JSON.parse(await boundedText(response, 2048));
  return proof.service === 'nemo' && proof.installationId === installationId && proof.challenge === challenge;
}

/** Runs inside Electron's bundled Node utility process, or the local setup CLI. */
export async function startDesktopHost({ dataDir, resourcesPath, openExternal = async () => {}, onAssistantConnected = async () => {}, registrationOrigin = process.env.NEMO_REGISTRATION_URL || '', createApp = createNemoServer, runtime: suppliedRuntime, assistantFactory = createDesktopAssistant, remoteFactory = createRemoteHost, setupFactory = createHostSetupServer, useProcessControl = true, cloud: suppliedCloud, connector: suppliedConnector, secretStore, verifyPublic = verifyRemoteInstallation } = {}) {
  let config = await loadConfig({ ...(dataDir ? { dataDir } : {}) });
  dataDir = config.dataDir;
  await ensureGmailPublisherClient({ dataDir, publisherPath: join(APP_ROOT, 'desktop', 'google-oauth.json') });
  let app, setup, control, remote, assistant, closing = false, closingTask, changing = Promise.resolve();
  const runtime = suppliedRuntime || await createSetupRuntime({ dataDir, resourcesPath });
  const profiles = await createProfileStore({ dataDir });
  registrationOrigin ||= runtime.bundle?.manifest?.registrationOrigin || '';
  const cloud = suppliedCloud || (registrationOrigin ? createRemoteCloudClient({ origin: registrationOrigin }) : undefined);
  const connector = suppliedConnector || createCloudflaredConnector(runtime.bundle?.connector);
  let installationId = '', publicOrigin = config.publicOrigin, trustedProxy = '';
  const serialize = operation => { const next = changing.catch(() => {}).then(operation); changing = next.then(() => {}, () => {}); return next; };
  async function startApp() {
    config = await loadConfig({ dataDir });
    const nodeExecutable = runtime.bundle?.node?.executablePath;
    const next = await createApp({ dataDir, publicOrigin, installationId, trustedProxy, logger() {},
      // Public v1 has one inference route, with renewable subscription tokens.
      hermesOptions: { launcher: config.hermesLauncher || undefined, hermesHome: config.hermesHome || undefined, hermesPython: config.hermesPython, hermesSource: config.hermesSource,
        requireChatGPT: true, chatgptSession: () => assistant.credentials(), chatgptStatus: () => assistant.status(), onChatGPTFailure: code => assistant.reportInferenceFailure?.(code), ...(nodeExecutable ? { nodeExecutable } : {}) },
      // This separate preview has its own provider settings. Preserve its saved
      // data, but do not expose another inference/billing path in desktop setup.
      nativeFactory: null,
    });
    try {
      await new Promise((resolve, reject) => { next.server.once('error', reject); next.server.listen(config.port, '127.0.0.1', resolve); });
      app = next;
    } catch (error) { await next.close().catch(() => {}); throw error; }
  }
  async function restart() { if (closing) throw new Error('Nemo is closing.'); if (app) { await app.close(); app = null; } await startApp(); }
  const close = () => closingTask ||= (async () => {
    closing = true;
    const errors = [];
    for (const action of [() => remote?.close(), () => setup?.close(), () => changing, () => assistant?.close(), () => app?.close(), () => control?.close()]) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Nemo stopped, but could not confirm every cleanup step.');
  })();
  try {
    if (useProcessControl) control = await createProcessControl({ dataDir, onStop: () => { void close().catch(() => {}); } });
    await runtime.status();
    assistant = await assistantFactory({ dataDir, openExternal,
      onConnectionChanging: () => serialize(async () => {
        if (closing) throw new Error('Nemo is closing.');
        const current = app; app = null;
        await current?.close();
      }),
      onConnected: async information => {
        await serialize(restart);
        if (information?.planUsageEnabled === true) {
          try { await onAssistantConnected(); } catch { /* Focus is helpful, not a condition of a valid account grant. */ }
        }
      },
    });
    remote = await remoteFactory({ dataDir, cloud, connector, ...(secretStore ? { secretStore } : {}), verifyPublic,
      activateOrigin: (origin, identity) => serialize(async () => {
        if (config.port !== 8787) throw new Error('This installation needs the standard Nemo connection port.');
        const previous = { publicOrigin, installationId, trustedProxy };
        if (app && origin === publicOrigin && identity.installationId === installationId && trustedProxy === 'cloudflare') return { ready: true };
        const latest = await loadConfig({ dataDir });
        const settings = { port: latest.port, hermesLauncher: latest.hermesLauncher, hermesHome: latest.hermesHome, hermesPython: latest.hermesPython, hermesSource: latest.hermesSource };
        await saveConfig(dataDir, { ...settings, publicOrigin: origin });
        publicOrigin = origin; installationId = identity.installationId; trustedProxy = 'cloudflare';
        try { await restart(); }
        catch (error) {
          ({ publicOrigin, installationId, trustedProxy } = previous);
          await saveConfig(dataDir, { ...settings, publicOrigin });
          await restart().catch(() => {});
          throw error;
        }
        return { ready: true };
      }),
    });
    installationId = remote.status().installationId || '';
    // An existing managed address remains exact across restarts; restoration
    // still verifies the outside connection before offering another invitation.
    if (remote.status().publicOrigin && publicOrigin === remote.status().publicOrigin) trustedProxy = 'cloudflare';
    await startApp();
    const beginEnrollment = remote.beginEnrollment.bind(remote);
    const setupRemote = { ...remote, async beginEnrollment(input) { const result = await beginEnrollment(input); if (result.browserUrl) await openExternal(result.browserUrl); return result; } };
    setup = await setupFactory({ dataDir, profiles, remoteHost: setupRemote, assetsDir: join(APP_ROOT, 'public'),
      runtimeStatus: async () => ({ ...await runtime.status(), assistant: assistant.status(), connected: assistant.status().connected }),
      appStatus: async () => ({ ready: !!app && !closing, assistantConnected: assistant.status().connected, origin: `http://127.0.0.1:${config.port}` }),
      runtimeSetup: () => serialize(async () => { const result = await runtime.install(); await restart(); return result; }),
      assistantSetup: input => input?.retry === true && assistant.status().connected ? assistant.retryConnection() : assistant.begin(input),
      localInvite: async profileId => {
        const invitation = await profiles.invite(profileId, 'desktop-local', { ttlMs: 5 * 60_000 });
        return { url: `http://127.0.0.1:${config.port}/pair.html#invite=${encodeURIComponent(invitation.code)}`, profile: invitation.profile, expiresAt: invitation.expiresAt };
      },
    });
    // A failed restoration leaves setup usable, with a truthful retry state.
    void remote.restore().catch(() => {});
    return { bootstrapUrl: setup.bootstrapUrl, origin: setup.origin, close, profiles, remote };
  } catch (error) { await close().catch(() => {}); throw error; }
}

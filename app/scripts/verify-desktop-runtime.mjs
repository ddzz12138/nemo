import { loadDesktopBundle } from '../lib/setup-runtime.mjs';
import { verifyHermesBundle } from '../lib/hermes-bundle.mjs';
import { verifyHermesPackageRuntime } from '../lib/hermes-pm-bundle.mjs';
import { APP_ROOT } from '../lib/config.mjs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PM_CHECKS = ['resident', 'isolated', 'cli', 'dependencies'];

/** Verify the exact resources selected for this build. A preview runtime or a
 * different source folder cannot supply a missing packaged dependency. */
export async function verifyDesktopRuntime({ loadBundle = loadDesktopBundle, verifyAssistant = verifyHermesBundle, verifyPackageRuntime = verifyHermesPackageRuntime,
  scratch = join(APP_ROOT, '.work', 'desktop-runtime-verification', randomUUID()) } = {}) {
  const bundle = await loadBundle();
  if (!bundle.connector?.executablePath || !bundle.node?.executablePath || !bundle.manifest?.hermes) throw new Error('The desktop installer needs its verified assistant, tools and phone connector. Prepare the complete release resources first.');
  const result = await verifyAssistant({ root: bundle.root, manifest: bundle.manifest.hermes });
  if (!result.extras?.includes('mcp')) throw new Error('The assistant package needs its connected-tool support before an installer is built.');
  if (!bundle.manifest.hermes.verification?.relocated || !bundle.manifest.hermes.verification?.fakeProvider) throw new Error('The assistant must pass relocation and a synthetic provider reply before an installer is built.');
  if (!PM_CHECKS.every(key => bundle.manifest.hermes.pmRuntime?.[key] === true)) throw new Error('The desktop assistant needs its verified isolated Hermes package runtime before an installer is built.');
  const pmRuntime = await verifyPackageRuntime({ root: bundle.root, manifest: bundle.manifest.hermes, scratch });
  if (!PM_CHECKS.every(key => pmRuntime?.[key] === true)) throw new Error('The packaged Hermes tools could not pass their isolated runtime checks.');
  // The real stock CLI probe must also leave the sealed resource inventory
  // unchanged. All of its scratch data belongs outside the shipped payload.
  await verifyAssistant({ root: bundle.root, manifest: bundle.manifest.hermes });
  return { verified: true, assistantFiles: result.files, dependencies: result.dependencies, pmRuntime, node: bundle.manifest.node.version, phoneConnector: bundle.manifest.cloudflared.version, phoneServiceConfigured: !!bundle.manifest.registrationOrigin, note: 'No real provider or connected account was accessed by this verification.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await verifyDesktopRuntime(), null, 2));

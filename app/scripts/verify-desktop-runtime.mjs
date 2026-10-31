import { loadDesktopBundle } from '../lib/setup-runtime.mjs';
import { verifyHermesBundle } from '../lib/hermes-bundle.mjs';

const bundle = await loadDesktopBundle();
if (!bundle.connector?.executablePath || !bundle.node?.executablePath || !bundle.manifest?.hermes) throw new Error('The desktop installer needs its verified assistant, tools and phone connector. Prepare the complete release resources first.');
const result = await verifyHermesBundle({ root: bundle.root, manifest: bundle.manifest.hermes });
if (!result.extras?.includes('mcp')) throw new Error('The assistant package needs its connected-tool support before an installer is built.');
if (!bundle.manifest.hermes.verification?.relocated || !bundle.manifest.hermes.verification?.fakeProvider) throw new Error('The assistant must pass relocation and a synthetic provider reply before an installer is built.');
console.log(JSON.stringify({ verified: true, assistantFiles: result.files, dependencies: result.dependencies, node: bundle.manifest.node.version, phoneConnector: bundle.manifest.cloudflared.version, phoneServiceConfigured: !!bundle.manifest.registrationOrigin, note: 'No real provider or connected account was accessed by this verification.' }, null, 2));

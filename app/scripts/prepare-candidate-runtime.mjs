import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { APP_ROOT } from '../lib/config.mjs';
import { verifyHermesSource } from '../lib/hermes-source.mjs';
import { prepareReleaseInputs } from '../lib/release-inputs.mjs';
import { prepareHermesBundle } from '../lib/hermes-bundle.mjs';
import { prepareNodeRuntime } from './prepare-node-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const source = await verifyHermesSource(APP_ROOT);
const lock = JSON.parse(await readFile(join(APP_ROOT, 'desktop/hermes-release.json'), 'utf8'));
const inputs = await prepareReleaseInputs({ lock, cache: join(APP_ROOT, '.work/release-inputs') });
const out = join(APP_ROOT, '.work/desktop-runtime');
const result = await prepareHermesBundle({ sourceRoot: source.root, pythonRoot: inputs.pythonRoot, sitePackages: inputs.sitePackages, out, onProgress: message => console.log(message) });
// These writers merge the same staging manifest: run them sequentially.
await prepareNodeRuntime({ out });
await promisify(execFile)(process.execPath, [join(APP_ROOT, 'scripts/prepare-desktop-runtime.mjs')], { windowsHide: true, timeout: 180_000, maxBuffer: 1_000_000 });
const manifestPath = join(out,'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
manifest.sourceSnapshot = { upstreamSourceRevision: source.sourceRevision, publicRepositoryRevision: manifest.hermes.sourceRevision, sourceLockSha256: createHash('sha256').update(await readFile(join(APP_ROOT,'desktop/hermes-source.json'))).digest('hex') };
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ verified: true, sourceRevision: source.sourceRevision, files: result.files, dependencies: result.dependencies, realAccountsAccessed: false }));

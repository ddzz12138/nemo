import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import packaging from './desktop/packaging.cjs';
import { signOwnedWindowsFiles } from './lib/windows-signing.mjs';

const runtime = fileURLToPath(new URL('./.work/desktop-runtime/', import.meta.url));
export default {
  packagerConfig: {
    name: 'Nemo', executableName: 'Nemo', appBundleId: 'app.nemo.desktop',
    // Python and the connector need real resource paths; do not hide them in an archive.
    asar: false,
    extraResource: existsSync(runtime) ? [runtime] : [],
    ignore: packaging.ignore,
  },
  rebuildConfig: {},
  hooks: {
    async postPackage(_config, result) {
      if (result.platform !== 'win32') return;
      for (const output of result.outputPaths) {
        await packaging.pruneEmptyHermesDirectories(join(output, 'resources'));
        // Sign only Nemo before Squirrel archives it. Preserve the pinned
        // third-party runtime bytes and their sealed integrity inventory.
        await signOwnedWindowsFiles([join(output, 'Nemo.exe')]);
      }
    },
    async postMake(_config, results) {
      const installers = results.flatMap(result => result.artifacts).filter(file => file.endsWith('NemoSetup.exe'));
      if (installers.length) await signOwnedWindowsFiles(installers);
      else if (process.env.NEMO_REQUIRE_SIGNING === '1') throw new Error('The signed Windows installer was not produced.');
      return results;
    },
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'Nemo', authors: 'Nemo', description: 'Your family’s assistant, on your phone', setupExe: 'NemoSetup.exe', noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'], config: {} },
  ],
};

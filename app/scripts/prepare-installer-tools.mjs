import { copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Build-host tooling only. Squirrel invokes these generic names internally.
// electron-winstaller 5.4.4's install hook uses os.arch instead of os.arch(),
// so select the bundled helper explicitly after an ignore-scripts install.
if (process.platform === 'win32') {
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('The Windows installer needs an x64 or arm64 build host.');
  const require = createRequire(import.meta.url);
  const vendor = join(dirname(require.resolve('electron-winstaller/package.json')), 'vendor');
  for (const extension of ['exe', 'dll']) {
    const source = join(vendor, `7z-${process.arch}.${extension}`);
    const destination = join(vendor, `7z.${extension}`);
    const expected = createHash('sha256').update(await readFile(source)).digest('hex');
    await copyFile(source, destination);
    const actual = createHash('sha256').update(await readFile(destination)).digest('hex');
    if (actual !== expected) throw new Error('The installer compression helper failed verification.');
  }
  console.log(`Prepared the bundled ${process.arch} Windows installer compression helper.`);
}

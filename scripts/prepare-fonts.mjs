import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Official, unmodified Ranade webfonts. Source binaries are deliberately not committed.
export const fonts = Object.freeze([
  { file: 'ranade-regular.woff2', bytes: 21880, sha256: '8df8657d91de903cc26d42b7a17df0129dc2f8a20013bd65da8b4d8b0b2a92c3',
    url: 'https://cdn.fontshare.com/wf/VTABUNXESC35DOCRFNLIWPSTHJEOCY4Q/GIHU5SZ7WYPXDURVYYYDCWYCQVT4M3H6/RXZ46KOEDGXL7HVIXMJIAZICDYUR5QZJ.woff2' },
  { file: 'ranade-medium.woff2', bytes: 21744, sha256: '172b85b509d277ba35c1743450d09e821d2172cb36596db77fbc7a9cce013fac',
    url: 'https://cdn.fontshare.com/wf/L2AEEUUCQUY3W76W527KO7I3IN7WDYKB/BLGYO6PMF754OJLYL5JD33PPYVDHNGZ5/7BXN3ORLQXOR6A3D5ZRM4EDMGISGKSZ2.woff2' },
]);
const defaultDirectory = fileURLToPath(new URL('../docs/assets/fonts/', import.meta.url));
export function validateFont(bytes, font) {
  if (bytes.length !== font.bytes || bytes.toString('ascii', 0, 4) !== 'wOF2' ||
      createHash('sha256').update(bytes).digest('hex') !== font.sha256) {
    throw new Error(`Official font verification failed: ${font.file}`);
  }
}
export async function prepareFonts({ directory = defaultDirectory, download = fetch, force = false } = {}) {
  await mkdir(directory, { recursive: true });
  for (const font of fonts) {
    const destination = join(directory, font.file);
    if (!force) {
      try { validateFont(await readFile(destination), font); continue; }
      catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
    }
    const response = await download(font.url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error(`Font download failed: ${font.file} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    validateFont(bytes, font);
    const temporary = join(directory, `.download-${randomUUID()}`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareFonts({ force: process.argv.includes('--refresh') });
  console.log('Ranade regular and medium verified for this website. Font binaries remain outside Git.');
}

import { readFile, mkdir, writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { APP_ROOT } from '../lib/config.mjs';
import { fileDigest } from '../lib/setup-runtime.mjs';

// Release maintenance only. Parents receive this connector inside their installer.
const release = JSON.parse(await readFile(new URL('../desktop/cloudflared-release.json', import.meta.url), 'utf8'));
if (release.platform !== process.platform || release.arch !== process.arch) throw new Error('A verified connector pin is required for this platform before packaging.');
const url = new URL(release.url);
if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/cloudflare/cloudflared/releases/download/') || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isInteger(release.bytes) || release.bytes > 100_000_000) throw new Error('Invalid connector release pin.');
const directory = join(APP_ROOT, '.work', 'desktop-runtime'), path = join(directory, 'cloudflared.exe');
await mkdir(directory, { recursive: true });
let verified = false;
try { verified = await fileDigest(path) === release.sha256; } catch {}
if (!verified) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error('The verified connector could not be downloaded.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > release.bytes) throw new Error('Connector download size did not match the release.'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (size !== release.bytes || createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Connector download checksum did not match the release.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes); await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}
let existing = {};
try { existing = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing.version && (existing.version !== 1 || existing.platform !== process.platform || existing.arch !== process.arch)) throw new Error('The runtime staging folder belongs to another build.');
let registrationOrigin = process.env.NEMO_BUILD_REGISTRATION_URL || existing.registrationOrigin || '';
if (registrationOrigin) {
  const service = new URL(registrationOrigin);
  if (service.protocol !== 'https:' || service.username || service.password || service.pathname !== '/' || service.search || service.hash) throw new Error('The release sign-in service must be an exact HTTPS origin.');
  registrationOrigin = service.origin;
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...existing, version: 1, platform: process.platform, arch: process.arch, ...(registrationOrigin ? { registrationOrigin } : {}), cloudflared: { file: 'cloudflared.exe', sha256: release.sha256, version: release.version } }, null, 2));
await copyFile(join(APP_ROOT, 'references', 'cloudflared-LICENSE.txt'), join(directory, 'LICENSE-cloudflared.txt'));
await copyFile(join(APP_ROOT, 'THIRD_PARTY_NOTICES.md'), join(directory, 'THIRD_PARTY_NOTICES.md'));
console.log('Verified phone connector prepared. The complete assistant runtime is a separate required release resource.');

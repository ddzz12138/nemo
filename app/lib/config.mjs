import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './profile-store.mjs';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OPERATING_LIMITS = Object.freeze({ activeMs: 600_000, toolCalls: 64, cloudTasks: 2, subagents: 2, localGpuJobs: 1 });

export function defaultDataDir({ root = APP_ROOT, env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  if (env.NEMO_DATA_DIR) {
    if (!isAbsolute(env.NEMO_DATA_DIR)) throw new Error('NEMO_DATA_DIR must be an absolute directory.');
    return resolve(env.NEMO_DATA_DIR);
  }
  // Never abandon an existing installation's pairings or encrypted grants.
  const legacy = join(root, '.nemo');
  if (exists(legacy)) return legacy;
  // Squirrel replaces LOCALAPPDATA/Nemo during installation. Private data must
  // live beside that program directory, never inside its replacement boundary.
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'NemoData');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Nemo');
  throw new Error('Nemo currently supports Windows and macOS hosts.');
}

export function validatePublicOrigin(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('Use an HTTPS origin, for example https://nemo.example.com.'); }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname || url.origin === 'null') throw new Error('Use only an HTTPS origin without a path, credentials, query or fragment.');
  return url.origin;
}

export async function loadConfig({ dataDir, root = APP_ROOT, env = process.env, platform = process.platform, ...defaults } = {}) {
  dataDir ||= defaultDataDir({ root, env, platform, ...defaults });
  let saved = {};
  try { saved = JSON.parse(await readFile(join(dataDir, 'nemo.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Nemo configuration could not be read. Preserve nemo.json before repairing it.'); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || (saved.version !== undefined && saved.version !== 1)) throw new Error('Unsupported Nemo configuration.');
  const port = Number(env.NEMO_PORT || saved.port || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('NEMO_PORT must be between 1024 and 65535.');
  let legacyOrigin = env.NEMO_PRIVATE_URL || '';
  if (!legacyOrigin && !saved.publicOrigin) {
    try { legacyOrigin = JSON.parse(await readFile(join(dataDir,'connection.json'),'utf8')).privateUrl || ''; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('The existing private connection configuration could not be read.'); }
  }
  const publicOrigin = validatePublicOrigin(env.NEMO_PUBLIC_ORIGIN || saved.publicOrigin || legacyOrigin);
  return { version: 1, dataDir: resolve(dataDir), port, publicOrigin, telemetry: false,
    hermesLauncher: env.NEMO_HERMES_LAUNCHER || saved.hermesLauncher || '',
    hermesHome: env.NEMO_HERMES_HOME || saved.hermesHome || '',
    hermesPython: env.NEMO_HERMES_PYTHON || saved.hermesPython || '', hermesSource: env.NEMO_HERMES_SOURCE || saved.hermesSource || '', runtime: 'guarded-cli', platform };
}

export async function saveConfig(dataDir, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['publicOrigin', 'port', 'hermesLauncher', 'hermesHome', 'hermesPython', 'hermesSource'].includes(key))) throw new Error('Unsupported setup setting.');
  for (const key of ['hermesLauncher', 'hermesHome', 'hermesPython', 'hermesSource']) if (input[key] && (typeof input[key] !== 'string' || !isAbsolute(input[key]) || /[\r\n\0]/.test(input[key]))) throw new Error(`${key} must be an absolute local path.`);
  const publicOrigin = validatePublicOrigin(input.publicOrigin || '');
  const port = input.port ?? 8787;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  const config = { version: 1, publicOrigin, port, hermesLauncher: input.hermesLauncher || '', hermesHome: input.hermesHome || '', hermesPython: input.hermesPython || '', hermesSource: input.hermesSource || '', telemetry: false };
  await mkdir(dataDir, { recursive: true });
  await writeJson(join(dataDir, 'nemo.json'), config);
  return config;
}

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeHome, NativeSessionClient } from './native-session.mjs';
import {connectionTools as knownTools} from './connections.mjs';
import {INTERACTION_TOOLS} from './native-interactions.mjs';
import { writeJson } from './profile-store.mjs';
import { verifyNativeRuntime } from './native-compatibility.mjs';

/** Native chat and fixed host-relayed reads. Computer tools require separate
 * verified Docker workers. This factory cannot enable them or inherit host auth. */
export async function startNativeChatWorker({ dataDir, profile, pythonPath, sourceRoot, brokerUrl, brokerGrant, model, apiMode, connectionTools=[],interactions=false,spawn = nodeSpawn, environment = process.env, verifyRuntime = verifyNativeRuntime, signal }) {
  if (!profile || profile.disabled || ![pythonPath, sourceRoot].every(path => typeof path === 'string' && isAbsolute(path)) || !/^[a-f0-9]{64}$/.test(brokerGrant || '') || !['chat_completions', 'codex_responses'].includes(apiMode) || typeof model !== 'string' || !model || model.length > 200) throw new Error('A verified native chat runtime and trusted profile are required.');
  let url; try { url = new URL(brokerUrl); } catch { throw new Error('A private loopback provider broker is required.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password) throw new Error('A private loopback provider broker is required.');
  const compatibility = await verifyRuntime({ sourceRoot }); if (compatibility?.supported !== true || compatibility.policy !== 'chat-only') throw new Error('The native chat policy has not been verified.');
  if(!Array.isArray(connectionTools)||connectionTools.some(tool=>!knownTools.some(known=>JSON.stringify(known)===JSON.stringify(tool)))||new Set(connectionTools.map(tool=>tool.name)).size!==connectionTools.length||connectionTools.length&&compatibility.managedReads!==true)throw new Error('The managed read-tool runtime has not been verified.');
  if(typeof interactions!=='boolean'||interactions&&compatibility.managedInteractions!==true)throw new Error('The native question/checklist runtime has not been verified.');
  if(signal?.aborted)throw new Error('Native startup was cancelled.');
  const home = await prepareNativeHome({ dataDir, profileId: profile.id });
  const marker = { version: 1, profileId: profile.id, mode: 'chat-only' };
  const existing = await readFile(join(home, 'config.yaml'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing !== null) {
    const saved = await readFile(join(home, 'nemo-managed.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (JSON.stringify(saved) !== JSON.stringify(marker)) throw new Error('This Hermes home is not a managed Nemo chat worker. Preserve it before migration.');
  }
  const workspace = join(home, 'workspace'), temporary = join(home, 'scratch'); await mkdir(workspace, { recursive: true }); await mkdir(temporary, { recursive: true });
  await writeJson(join(home, 'nemo-managed.json'), marker);
  // Chat-only workers need no shell/toolchain hints. Their background probe
  // would launch PATH Python/pip against the sealed bundle's dependency path.
  await writeJson(join(home, 'config.yaml'), { model: { default: model, provider: 'custom', base_url: brokerUrl, api_key: brokerGrant, api_mode: apiMode }, agent: { max_turns: 64, environment_probe: false }, dashboard: { turn_isolation: false }, auxiliary: { title_generation: { enabled: false } }, terminal: { cwd: workspace }, mcp_servers: {}, telemetry: { enabled: false },...(connectionTools.length?{nemo_read_tools:connectionTools}:{}),...(interactions?{nemo_interactions:true}:{}) });
  const env = {};
  for (const [key, value] of Object.entries(environment)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'LANG', 'LC_ALL'].includes(key.toUpperCase())) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), XDG_CACHE_HOME: join(home, 'cache'), HERMES_HOME: home, TMP: temporary, TEMP: temporary, TMPDIR: temporary, NEMO_NATIVE_PROFILE: profile.id, NEMO_CHILD_POLICY: profile.childMode === true ? 'child-v1' : 'standard-v1', HERMES_IGNORE_RULES: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', NO_PROXY: '127.0.0.1' });
  const helper = fileURLToPath(new URL('./native_worker.py', import.meta.url));
  env.HERMES_DISABLE_LAZY_INSTALLS = '1';
  const bootstrap = `import sys, runpy; sys.path.insert(0, ${JSON.stringify(sourceRoot)}); import hermes_bootstrap; runpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
  if(signal?.aborted)throw new Error('Native startup was cancelled.');
  const child = spawn(pythonPath, ['-I', '-B', '-c', bootstrap], { cwd: workspace, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stopped=new Promise(resolve=>child.once('close',resolve));
  const client = new NativeSessionClient({ profileId: profile.id, input: child.stdin, output: child.stdout, requireChatGuard: true, expectedTools:[...connectionTools.map(tool=>'mcp__nemo__'+tool.name),...(interactions?INTERACTION_TOOLS:[])],learningPolicy: env.NEMO_CHILD_POLICY, requestTimeoutMs: 30_000 });
  child.stderr.resume(); child.on('error', () => client.close()); child.on('close', () => client.close()); client.on('disconnected', () => child.kill());
  await new Promise((resolve, reject) => {
    const abort=()=>client.close();
    const timer = setTimeout(() => { client.close(); reject(new Error('Native worker did not become ready. The existing chat bridge remains available.')); }, 30_000);
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    client.once('ready', () => { clean(); resolve(); });
    client.once('disconnected', () => { clean(); reject(new Error('Native worker startup failed. The existing chat bridge remains available.')); });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  return { profileId: profile.id, home, client, close() { client.close(); child.kill();return stopped; } };
}

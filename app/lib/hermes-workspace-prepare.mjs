import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHermesWorkspace } from './hermes-memory.mjs';
import { verifyNativeRuntime } from './native-compatibility.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PACKAGES = new Set(['agent-browser', 'chromium', 'cua-driver']);
const STAGES = new Set(['prepare', 'download', 'unpack', 'verify', 'ready']);
const failure = () => new Error('Hermes could not prepare its browser and computer tools. Try again on this computer.');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const available = (value, name) => ({ available: value === true, ...(value === true ? {} : { message: `Hermes ${name} tools need preparation on this computer.` }) });

/** An explicit local-owner action. Package identities, installer and hashes all
 * come from unchanged upstream PM; callers cannot choose packages or commands.
 * No downloads occur until this function is called. */
export async function prepareHermesWorkspaceTools({ profile, dataDir, pythonPath, sourceRoot, home, onProgress, signal,
  spawn = nodeSpawn, environment = process.env, verifyRuntime = verifyNativeRuntime, timeoutMs = 20 * 60_000 }) {
  if (!profile || profile.role !== 'owner' || profile.childMode === true || profile.disabled || !UUID.test(profile.id || '')
      || ![dataDir, pythonPath, sourceRoot, home].every(path => typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path))) {
    throw new Error('Only the authenticated host owner can prepare Hermes tools.');
  }
  const root = await realpath(dataDir);
  const registry = JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8'));
  if (registry.version !== 2 || !registry.profiles?.some(row => row.id === profile.id && row.role === 'owner' && !row.disabled && row.childMode !== true)) throw new Error('The host owner is no longer available.');
  const expectedHome = await prepareHermesWorkspace({ profileId: profile.id, profileDataDir: join(root, 'profiles', profile.id) });
  if (!samePath(resolve(await realpath(home)), resolve(expectedHome))) throw new Error('The Hermes workspace does not belong to this person.');
  if ((await verifyRuntime({ sourceRoot }))?.supported !== true) throw new Error('This Hermes runtime needs compatibility review.');
  if (signal?.aborted) throw new Error('Hermes tool preparation was cancelled.');
  const workspace = join(home, 'workspace'), temporary = join(home, 'scratch');
  await mkdir(workspace, { recursive: true }); await mkdir(temporary, { recursive: true });
  const env = {};
  for (const [key, value] of Object.entries(environment)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'LANG', 'LC_ALL'].includes(key.toUpperCase())) env[key] = value;
  // Win32's standard extended path spelling permits PM's hash-based scratch
  // names under a long private profile path. It refers to the same files and
  // changes neither system long-path settings nor upstream filesystem code.
  const privateHome = toNamespacedPath(home), privateTemporary = toNamespacedPath(temporary);
  Object.assign(env, { HOME: privateHome, USERPROFILE: privateHome, APPDATA: join(privateHome, 'appdata'), LOCALAPPDATA: join(privateHome, 'localappdata'), XDG_CACHE_HOME: join(privateHome, 'cache'), HERMES_HOME: privateHome,
    TMP: privateTemporary, TEMP: privateTemporary, TMPDIR: privateTemporary, NEMO_WORKSPACE_PROFILE: profile.id, NEMO_WORKSPACE_ROOT: toNamespacedPath(root),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', HERMES_VERBOSE: '0' });
  const helper = fileURLToPath(new URL('./hermes_workspace_prepare.py', import.meta.url));
  const boundary = fileURLToPath(new URL('./hermes_workspace_worker.py', import.meta.url));
  const bootstrap = `import sys, runpy; sys.path.insert(0, ${JSON.stringify(sourceRoot)}); import hermes_bootstrap; b=runpy.run_path(${JSON.stringify(boundary)}); b['install_owner_process_boundary'](); runpy.run_path(${JSON.stringify(helper)}, run_name='__main__')`;
  const child = spawn(pythonPath, ['-I', '-B', '-c', bootstrap], { cwd: workspace, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolvePreparation, reject) => {
    let buffer = '', result = null, stopping = false, reason = null, settled = false, forceTimer, stopTimer;
    const settle = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolvePreparation(value);
    };
    const force = () => {
      try {
        if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
        else child.kill(); // The Windows Job Object owns this process's descendants.
      } catch (error) { if (error.code !== 'ESRCH') reason = failure(); }
      stopTimer = setTimeout(() => settle(Object.assign(new Error('Hermes could not confirm that tool preparation stopped. Check this computer before continuing.'), { stopUnconfirmed: true })), 1000);
    };
    const stop = error => {
      if (stopping || settled) return; stopping = true; reason = error;
      try { child.stdin.write('{"cancel":true}\n'); child.stdin.end(); } catch {}
      forceTimer = setTimeout(force, 1000);
    };
    const abort = () => stop(new Error('Hermes tool preparation was cancelled.'));
    const timer = setTimeout(() => stop(new Error('Hermes tool preparation took too long. Try again on this computer.')), timeoutMs);
    child.stdin.on('error', () => {}); child.stderr.on('error', () => {}); child.stdout.on('error', () => stop(failure())); child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.once('error', () => stop(failure()));
    child.once('close', code => {
      if (reason) return settle(reason);
      if (code !== 0 || !result) return settle(failure());
      settle(null, result);
    });
    child.stdout.on('data', chunk => {
      if (stopping || settled) return;
      buffer += chunk;
      if (buffer.length > 65_536) return stop(failure());
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let frame; try { frame = JSON.parse(line); } catch { return stop(failure()); }
        if (frame?.type === 'progress' && PACKAGES.has(frame.package) && STAGES.has(frame.stage)) {
          const progress = { package: frame.package, stage: frame.stage, done: Number.isSafeInteger(frame.done) && frame.done >= 0 ? frame.done : 0, total: Number.isSafeInteger(frame.total) && frame.total >= 0 ? frame.total : 0 };
          try { onProgress?.(progress); } catch {}
        } else if (frame?.type === 'result' && typeof frame.browser === 'boolean' && typeof frame.computer === 'boolean' && !result) {
          result = { ok: frame.browser && frame.computer, tools: { browser: available(frame.browser, 'browser'), computer: available(frame.computer, 'computer') } };
          if (!result.ok && frame.code === 'HERMES_PM_RUNTIME_UNAVAILABLE') result.message = 'Install the latest Nemo desktop build before preparing these tools.';
        } else return stop(failure());
      }
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

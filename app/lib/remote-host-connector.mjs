import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Only packaged, hash-pinned binaries can run. No PATH lookup, shell or token argv. */
export function createCloudflaredConnector({ executablePath, sha256, spawnImpl = spawn, stopTimeoutMs = 3_000 } = {}) {
  let child = null;
  async function verify() {
    if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || /[\r\n\0]/.test(executablePath) || !/^[a-f0-9]{64}$/i.test(sha256 || '')) throw new Error('Remote access is not included in this Nemo release yet.');
    const file = await lstat(executablePath).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error('Nemo needs to repair its remote connection. Please reinstall the verified app.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
    if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error('Nemo needs to repair its remote connection. Please reinstall the verified app.');
  }
  return {
    async available() { try { await verify(); return true; } catch { return false; } },
    async start(token, { onExit = () => {} } = {}) {
      if (child) throw new Error('Nemo is already connecting.');
      if (typeof token !== 'string' || token.length < 16 || token.length > 32_768 || /[\r\n\0]/.test(token)) throw new Error('Nemo needs a new remote connection. Please sign in again.');
      await verify();
      const env = { TUNNEL_TOKEN: token, NO_COLOR: '1' };
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
      // A dedicated child environment is transient. Credentials never enter
      // command arguments, plaintext files, parent environment, or diagnostics.
      const processChild = spawnImpl(executablePath, ['tunnel', '--no-autoupdate', '--loglevel', 'error', 'run'], { shell: false, windowsHide: true, env, stdio: 'ignore' });
      child = processChild;
      let intentional = false, ended = false;
      processChild.nemoStop = () => { intentional = true; };
      const end = () => { if (ended) return; ended = true; if (child === processChild) child = null; if (!intentional) onExit(); };
      processChild.once('error', end); processChild.once('close', end);
      await new Promise((resolve, reject) => { processChild.once('spawn', resolve); processChild.once('error', () => reject(new Error('Nemo could not start its remote connection. Please try again.'))); });
    },
    async stop() {
      const stopping = child;
      if (!stopping) return;
      stopping.nemoStop();
      await new Promise((resolve, reject) => {
        let done = false;
        let forceTimer;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(forceTimer); if (child === stopping) child = null; resolve(); };
        const failed = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(forceTimer); reject(new Error('Nemo could not confirm that its phone connection stopped. Close Nemo and try again.')); };
        const timer = setTimeout(() => {
          forceTimer = setTimeout(failed, stopTimeoutMs);
          try { stopping.kill('SIGKILL'); } catch { failed(); }
        }, stopTimeoutMs);
        stopping.once('close', finish);
        try { stopping.kill(); } catch { failed(); }
      });
    },
  };
}

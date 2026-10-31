import net from 'node:net';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export async function createProcessControl({ dataDir, onStop }) {
  const marker = join(dataDir, 'cli-process.json');
  const nonce = randomBytes(32).toString('hex');
  // A Windows pipe is released by the OS even after a crash or power loss.
  // All current starters hold it while recovering/writing the discovery file,
  // so two simultaneous retries cannot remove one another's new marker.
  let ownership = null, closing = null;
  if (process.platform === 'win32') {
    ownership = net.createServer(socket => socket.destroy());
    const identity = createHash('sha256').update((await realpath(dataDir)).toLowerCase()).digest('hex');
    try { await new Promise((resolve, reject) => { ownership.once('error', reject); ownership.listen('\\\\.\\pipe\\nemo-host-'+identity, resolve); }); }
    catch { throw Object.assign(new Error('Nemo is already starting or running for this installation.'), { code: 'NEMO_CONTROL_BUSY' }); }
  }
  let stopRequested = false;
  const server = net.createServer(socket => {
    let bytes = ''; let handled = false; socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      bytes += chunk;
      if (bytes.length > 512) return socket.destroy();
      if (!bytes.includes('\n')) return;
      handled = true;
      let input; try { input = JSON.parse(bytes.trim()); } catch { return socket.destroy(); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.command !== 'stop' || typeof input.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(input.nonce) || !timingSafeEqual(Buffer.from(input.nonce, 'hex'), Buffer.from(nonce, 'hex'))) return socket.end('denied\n');
      socket.end('stopping\n');
      if (!stopRequested) { stopRequested = true; onStop(); }
    });
  });
  const closeServer = target => target?.listening ? new Promise(resolve => target.close(resolve)) : Promise.resolve();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const value = JSON.stringify({ version: 1, port: server.address().port, nonce });
    try { await writeFile(marker, value, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !ownership) throw error;
      const original = await readFile(marker), saved = JSON.parse(original);
      if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(saved.nonce || '')) throw new Error('Invalid saved controller.');
      // Never send the old secret, stop a process, or reclaim a listener just
      // because its response is slow/unrecognized. Only definite refusal counts.
      const inactive = await new Promise(resolve => {
        const socket = net.connect(saved.port, '127.0.0.1'); let done = false;
        const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
        socket.setTimeout(1500, () => finish(false)); socket.once('connect', () => finish(false)); socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
      });
      if (!inactive || !(await readFile(marker)).equals(original)) throw new Error('The saved controller may still be active.');
      await rename(marker, join(dataDir, 'cli-process.recovered-'+randomUUID()+'.json'));
      await writeFile(marker, value, { flag: 'wx', mode: 0o600 });
    }
  } catch {
    await closeServer(server); await closeServer(ownership);
    throw Object.assign(new Error('A CLI process marker already exists or could not be verified. No existing process was stopped.'), { code: 'NEMO_CONTROL_BUSY' });
  }
  return { close() { return closing ||= (async () => {
    try { await closeServer(server); const saved = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null); if (saved?.nonce === nonce) await unlink(marker); }
    finally { await closeServer(ownership); }
  })(); } };
}

export async function stopManagedProcess(dataDir) {
  let saved;
  try { saved = JSON.parse(await readFile(join(dataDir, 'cli-process.json'), 'utf8')); }
  catch { throw new Error('This installation has no managed CLI process.'); }
  if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(saved.nonce)) throw new Error('The process marker is invalid. No process was stopped.');
  await new Promise((resolve, reject) => {
    const socket = net.connect(saved.port, '127.0.0.1');
    socket.setTimeout(2000, () => socket.destroy(new Error('timeout')));
    socket.once('connect', () => socket.write(JSON.stringify({ command: 'stop', nonce: saved.nonce }) + '\n'));
    let result = '';
    socket.on('data', part => { result += part; if (result.length > 64) socket.destroy(); });
    socket.once('end', () => result.trim() === 'stopping' ? resolve() : reject(new Error('The managed process did not authorize stopping.')));
    socket.once('error', () => reject(new Error('The managed CLI is not reachable. No arbitrary process was stopped.')));
  });
}

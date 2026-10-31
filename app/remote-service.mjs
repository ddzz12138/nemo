import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteCloudServer, remoteCloudConfigFromEnv } from './lib/remote-cloud-service.mjs';

/** One process per persistent database. The lock deliberately fails closed after a crash. */
export async function startRemoteService(config = remoteCloudConfigFromEnv()) {
  await mkdir(dirname(config.dataFile), { recursive: true, mode: 0o700 });
  const lockPath = `${config.dataFile}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('The remote service database is locked. Stop the other service process. After a crash, verify it is stopped before removing the .lock file.'); throw error; }
  let server, service;
  try {
    const result = createRemoteCloudServer({ config, onError: ({ code, status }) => console.error(`Remote service request failed: ${code} (${status})`) });
    server = result.server; service = result.service;
    await result.store.read(state => state.version); // Detect corrupt/unreadable state before accepting sign-in.
    await lock.writeFile(String(process.pid));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  const close = async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await lock.close(); await rm(lockPath, { force: true });
  };
  return { server, service, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const instance = await startRemoteService();
    console.log('Nemo registration service is listening. HTTPS termination and persistent storage are required at the hosting layer.');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; try { await instance.close(); process.exitCode = 0; } catch { process.exitCode = 1; } };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

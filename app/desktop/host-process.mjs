import { startDesktopHost } from '../lib/desktop-host.mjs';
import { randomUUID } from 'node:crypto';

const parent = process.parentPort;
if (!parent) throw new Error('Start Nemo through its desktop application.');
const pending = new Map();
let host, starting, closingTask, shutdownComplete = false;
async function close() {
  if (closingTask) return closingTask;
  const operation = (async () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Nemo is closing.')); }
    pending.clear();
    await starting?.catch(() => {});
    await host?.close();
    shutdownComplete = true;
    parent.postMessage({ type: 'shutdown-complete' });
  })();
  closingTask = operation;
  try { await operation; }
  catch {
    closingTask = null;
    parent.postMessage({ type: 'shutdown-failed' });
  }
}
parent.on('message', ({ data }) => {
  if (data?.type === 'shutdown') void close();
  if (data?.type === 'shutdown-ack' && shutdownComplete) process.exit(0);
  if (data?.type === 'external-result') {
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId); clearTimeout(request.timer);
    if (data.ok) request.resolve(); else request.reject(new Error('Nemo could not open sign-in. Return to setup and try again.'));
  }
});
try {
  starting = startDesktopHost({
    dataDir: process.env.NEMO_DESKTOP_DATA_DIR,
    resourcesPath: process.env.NEMO_DESKTOP_RESOURCES_PATH,
    onAssistantConnected() { parent.postMessage({ type: 'assistant-connected' }); },
    openExternal(url) {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Sign-in did not open. Try again.')); }, 15_000);
        pending.set(requestId, { resolve, reject, timer });
        parent.postMessage({ type: 'open-external', requestId, url });
      });
    },
  });
  host = await starting;
  if (!closingTask && !shutdownComplete) parent.postMessage({ type: 'ready', bootstrapUrl: host.bootstrapUrl });
} catch {
  // Never forward stack traces, paths, credentials or backend logs to the parent window.
  parent.postMessage({ type: 'failed', message: 'Nemo could not start. Close the app and open it again.' });
  process.exitCode = 1;
}

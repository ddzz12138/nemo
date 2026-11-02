'use strict';

const failure = code => Object.assign(new Error('Nemo could not confirm that its assistant stopped. Keep Nemo open and try quitting again.'), { code });

// The host owns native process cleanup. A timeout keeps Nemo open; it never
// turns a delayed cleanup into an unconfirmed process kill or successful quit.
function createDesktopShutdown({ background, saveSession = async () => {}, timeoutMs = 20_000 } = {}) {
  let acknowledged = false, exited = false, exitCode, failed = false, active = null;
  const observers = new Set();
  const changed = () => { for (const observer of observers) observer(); };
  if (background) {
    background.on('message', message => {
      if (message?.type === 'shutdown-complete') {
        acknowledged = true; failed = false;
        // The child waits for receipt before exiting, so its completion message
        // cannot be lost during immediate process termination.
        try { background.postMessage({ type: 'shutdown-ack' }); } catch { failed = true; }
        changed();
      } else if (message?.type === 'shutdown-failed') { failed = true; changed(); }
    });
    background.on('exit', code => { exited = true; exitCode = code; changed(); });
  }
  return {
    request() {
      if (active) return active;
      const operation = (async () => {
        await saveSession();
        if (!background) return;
        if (exited) { if (acknowledged && exitCode === 0) return; throw failure('NEMO_SHUTDOWN_UNCONFIRMED'); }
        failed = false;
        await new Promise((resolve, reject) => {
          let timer;
          const finish = error => { clearTimeout(timer); observers.delete(check); if (error) reject(error); else resolve(); };
          const check = () => {
            if (failed) finish(failure('NEMO_SHUTDOWN_FAILED'));
            else if (exited) finish(acknowledged && exitCode === 0 ? null : failure('NEMO_SHUTDOWN_UNCONFIRMED'));
          };
          observers.add(check);
          timer = setTimeout(() => finish(failure('NEMO_SHUTDOWN_PENDING')), timeoutMs);
          try { background.postMessage({ type: 'shutdown' }); } catch { finish(failure('NEMO_SHUTDOWN_FAILED')); }
          check();
        });
      })();
      active = operation;
      void operation.finally(() => { if (active === operation) active = null; }).catch(() => {});
      return operation;
    },
  };
}

module.exports = { createDesktopShutdown };

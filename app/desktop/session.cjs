'use strict';

// Keep this partition stable across releases. Its cookie store lives in
// Electron's userData directory, outside Squirrel's versioned program folder.
const PERSONAL_PARTITION = 'persist:nemo-personal-chat';

function persistPersonalSession(session) {
  let writing = Promise.resolve(), stopped = false;
  const flush = () => {
    const next = writing.catch(() => {}).then(() => session.cookies.flushStore());
    writing = next; next.catch(() => {}); return next;
  };
  const changed = (_event, cookie) => {
    if (!stopped && cookie?.name === 'nemo_session' && ['127.0.0.1', 'localhost', '.127.0.0.1', '.localhost'].includes(cookie.domain)) void flush();
  };
  session.cookies.on('changed', changed);
  return { flush, async close() { if (!stopped) { stopped = true; session.cookies.removeListener('changed', changed); } await flush(); } };
}

async function readPersonalSession(session, origin) {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Reopen Nemo to restore your saved sign-in.');
  const response = await session.fetch(target.origin + '/api/session', { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (response.status === 401) return { authenticated: false };
  // A temporary server failure is not evidence that the person signed out.
  // Keep their cookie, and never turn a failed read into fresh setup/invites.
  if (!response.ok) throw new Error('Nemo could not restore your sign-in right now. Reopen the app to retry.');
  const value = await response.json();
  if (typeof value?.authenticated !== 'boolean') throw new Error('Nemo could not confirm your saved sign-in. Reopen the app to retry.');
  return value;
}
module.exports = { PERSONAL_PARTITION, persistPersonalSession, readPersonalSession };

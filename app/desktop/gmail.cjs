'use strict';
const { gmailAuthorization, authorizeDesktopProfile } = require('./chat-contracts.cjs');

// Native main owns browser opening and authenticated Session requests. The
// sandboxed page supplies only a named operation and its displayed profile ID.
function createDesktopGmailAction({ getWindow, getOrigin, fetchSession, openExternal }) {
  return async (event, action, profileId) => {
    if (!['start', 'cancel'].includes(action)) throw new Error('Use the Gmail connection buttons in Settings.');
    const window = getWindow(), appOrigin = getOrigin();
    const authorize = () => authorizeDesktopProfile({ event, window, appOrigin, profileId, fetchSession });
    await authorize();
    const request = async operation => {
      const response = await window.webContents.session.fetch(`${appOrigin}/api/gmail/desktop/${operation}`, {
        method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Nemo-Request': '1', 'X-Nemo-Profile': profileId, Origin: appOrigin },
        body: '{}', signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Gmail sign-in could not be opened. Try again.');
      return result;
    };
    const result = await request(action);
    if (action === 'cancel') return { cancelled: true };
    try {
      await authorize();
      await openExternal(gmailAuthorization(result.authorizationUrl));
      return { opened: true };
    } catch (error) { await request('cancel').catch(() => {}); throw error; }
  };
}
module.exports = { createDesktopGmailAction };

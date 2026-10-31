'use strict';
const { chatSender } = require('./chat-contracts.cjs');

// The native menu already owns access to the private host setup window. The
// signed-out screen can request the same navigation, never a token or profile.
async function openDesktopSettings({ window, appOrigin, setupUrl, fetchSession, beforeNavigate = () => {} }) {
  const current = await fetchSession();
  if (typeof current?.authenticated !== 'boolean') throw new Error('Nemo could not confirm your sign-in. Try again.');
  beforeNavigate();
  await window.loadURL(current.authenticated ? appOrigin + '/desktop.html#settings' : setupUrl);
  return { opened: true };
}

function createHostAccessAction({ getWindow, getOrigin, getSetupUrl, fetchSession }) {
  return async (event, ...input) => {
    if (input.length) throw new Error('Use the Continue on this PC button in Nemo.');
    const window = getWindow(), appOrigin = getOrigin();
    const check = () => chatSender(event, window, appOrigin);
    check();
    return openDesktopSettings({ window, appOrigin, setupUrl: getSetupUrl(), fetchSession, beforeNavigate: check });
  };
}

module.exports = { openDesktopSettings, createHostAccessAction };

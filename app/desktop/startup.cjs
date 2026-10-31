'use strict';

async function openDesktopStartup({ window, appOrigin, setupUrl, status, fetchSession, openLocal }) {
  // Establish a first-party loopback document while the window is hidden before
  // checking its SameSite cookie. Keep this on the separate bootstrap origin so
  // a new personal invitation is a full navigation, not a pending hash-only load.
  await window.loadURL(setupUrl);
  const current = await fetchSession();
  if (current?.authenticated) { await window.loadURL(appOrigin + '/desktop.html'); return 'chat'; }
  const { canOpenPersonalSpace } = await import('../public/desktop-setup.mjs');
  if (canOpenPersonalSpace(status)) {
    // Older installations used the system browser. Offer a personal invitation
    // once in the desktop app; never redeem it or switch people automatically.
    await openLocal();
    return 'pairing';
  }
  return 'setup';
}

module.exports = { openDesktopStartup };

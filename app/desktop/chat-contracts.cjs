'use strict';
const LOCAL_PAGES = new Set(['/desktop.html']);
function chatLaunch(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/pair.html' || url.search || !/^#invite=[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(url.hash)) throw new Error('Open your personal space from Nemo setup.');
  url.pathname='/desktop.html';
  return { origin: url.origin, url: url.href };
}
function chatNavigation(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && (url.pathname === '/' || LOCAL_PAGES.has(url.pathname)) && !url.search; } catch { return false; }
}
function gmailAuthorization(value) {
  const url = new URL(value);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  if (url.origin !== 'https://accounts.google.com' || url.username || url.password || url.pathname !== '/o/oauth2/v2/auth' || url.hash || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port || callback.pathname !== '/oauth2/callback' || callback.search || callback.hash || callback.username || callback.password || url.searchParams.get('scope') !== 'https://www.googleapis.com/auth/gmail.readonly' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '') || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') || '')) throw new Error('Connect Gmail from your own Nemo settings.');
  return url.href;
}
function chatSender(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== origin + '/desktop.html') throw new Error('Open Settings in your Nemo desktop window.');
}
async function authorizeDesktopSetup({event,window,setupUrl,appOrigin,profileId,fetchSession}) {
  if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Open Settings in your Nemo desktop window.');
  if(event.senderFrame.url===setupUrl)return;
  chatSender(event,window,appOrigin);
  if(typeof profileId!=='string'||!profileId)throw new Error('Confirm your personal profile before changing home settings.');
  const session=await fetchSession();
  if(!session?.authenticated||session.profile?.role!=='owner'||session.profile.id!==profileId)throw new Error('Your family owner manages this home’s assistant settings.');
  // Authentication can finish after a navigation. Revalidate the caller too.
  chatSender(event,window,appOrigin);
}
async function authorizeDesktopProfile({ event, window, appOrigin, profileId, fetchSession }) {
  chatSender(event, window, appOrigin);
  const current = await fetchSession();
  chatSender(event, window, appOrigin);
  if (!current?.authenticated || typeof profileId !== 'string' || !profileId || current.profile?.id !== profileId) throw new Error('Your profile changed. Open Settings again.');
  return current;
}
module.exports = { chatLaunch, chatNavigation, gmailAuthorization, chatSender, authorizeDesktopSetup, authorizeDesktopProfile };

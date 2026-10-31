// Public address handling only. Invitations remain private and are validated
// again by the signed transport before a profile can be accessed.
export function phoneAppOrigin(value) {
  let url;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter the HTTPS address of the Nemo phone app.');
  try { url = new URL(value); } catch { throw new Error('Enter the HTTPS address of the Nemo phone app.'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || !['/', '/phone-start', '/phone-start.html'].includes(url.pathname)) throw new Error('Use the phone app address without an invitation, query or other path.');
  // Pages deployment URLs are immutable. New invitations must use the project's
  // stable production address so interface fixes reach the installed phone app.
  const preview = /^([a-f0-9]{8})\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pages\.dev$/i.exec(url.hostname);
  if (preview) url.hostname = preview[2] + '.pages.dev';
  return url.origin;
}

export function phoneInvitationPath(value, currentOrigin) {
  let url;
  if (typeof value !== 'string' || value.length > 6500) throw new Error('Paste the complete personal invitation link.');
  try { url = new URL(value); } catch { throw new Error('Paste the complete personal invitation link.'); }
  if (url.username || url.password || url.search || !['/pair', '/pair.html'].includes(url.pathname)
    || phoneAppOrigin(url.origin) !== phoneAppOrigin(currentOrigin)
    || !new URLSearchParams(url.hash.slice(1)).get('phone')) throw new Error('Use a personal invitation for this Nemo phone app.');
  return '/pair.html' + url.hash;
}

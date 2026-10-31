// Native menu links and new invitations may arrive as same-document navigations.
// Read a fragment once, then remove invitation codes before any request starts.
export function takeDesktopRoute(location, history) {
  const raw=location.hash.slice(1),fragment=new URLSearchParams(raw);
  const invitation=fragment.has('invite') ? fragment.getAll('invite').length===1 ? fragment.get('invite') : '' : null;
  const page=['settings','family','memory','school'].includes(raw)?raw:'chat';
  if(location.hash)history.replaceState(null,'',location.pathname);
  return {page,invitation};
}

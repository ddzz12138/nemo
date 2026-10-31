import { useEffect, useRef, useState } from 'react';
import { createSetupClient, setupMessage } from '../../../public/desktop-setup.mjs';

export function useSetup(profileId) {
  const [status, setStatus] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const identity = useRef(profileId), active = useRef(false), working = useRef(false), revision = useRef(0), client = useRef(null);
  identity.current = profileId;
  if (!client.current) client.current = createSetupClient({ desktop: window.nemoDesktop, location: window.location, history: window.history, getProfileId: () => identity.current });
  async function refresh() {
    const version = ++revision.current, person = identity.current;
    const next = await client.current.request('status');
    if (active.current && version === revision.current && person === identity.current) setStatus(next);
    return next;
  }
  useEffect(() => {
    active.current = true; setStatus(null); setError('');
    const person=identity.current, initialRevision=revision.current+1;
    void refresh().catch(problem => { if (active.current && person===identity.current && initialRevision===revision.current) setError(setupMessage(problem)); });
    const timer = setInterval(() => { if (active.current && !working.current && !document.hidden) void refresh().catch(() => {}); }, 3000);
    return () => { active.current = false; revision.current++; clearInterval(timer); };
  }, [profileId]);
  async function act(label, operation) {
    if (working.current) return;
    working.current = true; revision.current++; setBusy(label); setError('');
    const person = identity.current;
    try { await operation(client.current.request); if (active.current && person === identity.current) await refresh(); }
    catch (problem) { if (active.current && person === identity.current) { setError(setupMessage(problem)); await refresh().catch(() => {}); } }
    finally { working.current = false; if (active.current && person === identity.current) setBusy(''); }
  }
  return { status, busy, error, act, refresh, request: client.current.request };
}

import React, { useEffect, useRef, useState } from 'react';
import { SidebarLayout } from './Layout.jsx';
import { createDesktopApi } from '../../../public/desktop-api.mjs';
import { setupMessage } from '../../../public/desktop-setup.mjs';

export function Pairing({ invitation = '', onConnected }) {
  const onHost = typeof window.nemoShell?.openHost === 'function';
  const [code, setCode] = useState(invitation), [preview, setPreview] = useState(null), [existing, setExisting] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const profile = useRef(null), revision = useRef(0), alive = useRef(true), lock = useRef(false);
  const api = useRef(null);
  if (!api.current) api.current = createDesktopApi({ fetchImpl: (...args) => window.nemoFetch(...args), getProfile: () => profile.current, getEpoch: () => window.NemoIdentity.epoch });
  useEffect(() => { alive.current = true; setCode(invitation);setPreview(null);setExisting(null);setError('');lock.current=false;if (invitation) void inspect(invitation); return () => { alive.current = false; revision.current++; }; }, [invitation]);
  async function operate(action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); const version = ++revision.current;
    try { await action(() => alive.current && revision.current === version); }
    catch (problem) { if (alive.current && revision.current === version) setError(setupMessage(problem)); }
    finally { lock.current = false; if (alive.current && revision.current === version) setBusy(false); }
  }
  async function inspect(value) {
    return operate(async current => {
      const normalized = value.toUpperCase().trim();
      if (!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(normalized)) throw new Error('Enter the personal invitation code from your family owner.');
      const session = await api.current.session(); if (!current()) return;
      profile.current = session.profile || null; setExisting(session.profile || null);
      const result = await api.current.request('/api/pair/preview', { code: normalized }); if (!current()) return;
      if (!result.profile?.id || !result.profile?.name) throw new Error('Nemo could not confirm who this invitation belongs to.');
      setCode(normalized); setPreview(result);
    });
  }
  async function connect() {
    if (!preview || existing) return;
    return operate(async current => {
      const expected = preview.profile.id;
      const result = await api.current.request('/api/pair', { code, expectedProfileId: expected, deviceName: 'Nemo desktop' });
      if (!current()) return;
      if (result.profile?.id !== expected) throw new Error('The connected profile changed. Reopen Nemo before continuing.');
      setCode(''); setPreview(null); onConnected();
    });
  }
  const invitationForm = <form className="setup-form" onSubmit={event => { event.preventDefault(); void inspect(code); }}><label htmlFor="desktop-invitation">Personal invitation code</label><input id="desktop-invitation" autoComplete="off" autoCapitalize="characters" maxLength="19" placeholder="ABCD-EFGH-JKLM-NPQR" value={code} onChange={event => setCode(event.target.value)} disabled={busy} /><button className="primary-button" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Check invitation'}</button></form>;
  return <SidebarLayout title="Your personal Nemo"><div className="onboarding-content"><div className="setup-intro"><span className="setup-symbol" aria-hidden="true">✳</span><h2>{preview ? `Hello, ${preview.profile.name}` : onHost ? 'Open Nemo on this PC' : 'Join your family’s Nemo'}</h2><p>{preview ? 'Check your name before opening your private space.' : onHost ? 'Continue with this home’s existing profile. Your chats and connected accounts are kept.' : 'Use your personal invitation. Your chats and connected accounts stay with your profile.'}</p></div>
    {error && <div role="alert" className="inline-error">{error}</div>}
    {!preview ? onHost ? <><div className="setup-complete"><button className="primary-button" disabled={busy} onClick={() => void operate(() => window.nemoShell.openHost())}>{busy ? 'Opening Nemo…' : 'Continue on this PC'}</button><p className="field-help">No family invitation code needed for the home owner.</p></div><details className="connection-details"><summary>Join another family profile</summary>{invitationForm}</details></> : invitationForm : <>
      {preview.profile.parentalReview && <p className="plan-notice">Family review is on. Your family owner can review your chats and personal Memory.</p>}
      {existing && existing.id !== preview.profile.id ? <><p className="quiet">This app is signed in as {existing.name}. Sign out before connecting as {preview.profile.name}. Their saved data stays on the home PC.</p><button className="app-button" disabled={busy} onClick={() => void operate(async current => { await api.current.request('/api/logout', {}); if (current()) { profile.current = null; setExisting(null); } })}>Sign out {existing.name}</button></> : existing ? <button className="primary-button" disabled={busy} onClick={onConnected}>Continue as {existing.name}</button> : <button className="primary-button" disabled={busy || Number(preview.expiresAt) <= Date.now()} onClick={() => void connect()}>{busy ? 'Connecting…' : `Open ${preview.profile.name}’s space`}</button>}
      <p className="field-help">This invitation works once. Signing out never deletes your saved data.</p>
    </>}
  </div></SidebarLayout>;
}

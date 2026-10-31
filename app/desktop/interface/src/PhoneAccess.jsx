import React, { useEffect, useState } from 'react';

export function PhoneAccess({ status, busy, act }) {
  const [invitation, setInvitation] = useState(null), [now, setNow] = useState(Date.now());
  const remote = status.remote || {}, account = remote.account || {}, enrollment = status.enrollment || account;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setInvitation(null); }, [remote.publicOrigin, remote.canPair]);
  const current = invitation && invitation.expiresAt > now ? invitation : null;
  async function enable(request) {
    if (!['approved', 'active', 'connected'].includes(account.state)) { const result = await request('enroll'); if (!['approved', 'active', 'connected'].includes(result.state)) return; }
    await request('enable');
  }
  async function invite(request) {
    const result = await request('invite', { profileId: status.owner.id });
    const target = new URL(result.url), expected = new URL(remote.publicOrigin);
    if (expected.protocol !== 'https:' || target.origin !== expected.origin || target.pathname !== '/pair.html' || target.search || target.username || target.password || !/^#invite=[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(target.hash) || result.profile?.id !== status.owner.id || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(result.qrDataUrl || '')) throw new Error('Nemo could not confirm the phone invitation. Try again.');
    setInvitation(result);
  }
  return <section className="phone-access-panel" aria-label="Phone access"><p className="quiet">{remote.message || 'This PC needs to stay awake and online when you use Nemo on a phone.'}</p>
    {remote.canPair ? <><button className="app-button" disabled={!!busy} onClick={() => void act('invite', invite)}>Invite my phone</button>{current && <div className="phone-invitation"><img src={current.qrDataUrl} width="200" height="200" alt={`Private phone invitation for ${current.profile.name}`} /><p>For {current.profile.name} · One use · {Math.ceil((current.expiresAt - now) / 60000)} min left</p></div>}{invitation && !current && <p role="status">This invitation expired. Create a new one.</p>}<button className="text-button" disabled={!!busy} onClick={() => { if (window.confirm('Turn off phone access? Saved profiles and chats stay on this PC.')) void act('disable', async request => { setInvitation(null); await request('disable'); }); }}>Turn off phone access</button></> : <>
      {['pending', 'awaiting-approval'].includes(enrollment.state) ? <><p role="status">Finish the sign-in in your browser, then check the connection.</p>{enrollment.confirmationCode && <p>Confirmation code: <strong>{enrollment.confirmationCode}</strong></p>}<button className="app-button" disabled={!!busy} onClick={() => void act('enroll', async request => { const result = await request('enrollment'); if (result.approved || ['approved', 'active', 'connected'].includes(result.state) || result.account?.state === 'approved') await request('enable'); })}>I’ve signed in</button></> : <button className="app-button" disabled={!!busy || remote.available === false} onClick={() => void act('enable', enable)}>{remote.available === false ? 'Not available in this preview' : 'Enable phone access'}</button>}
      {remote.retirementPending && <button className="text-button" disabled={!!busy} onClick={() => void act('disable', request => request('disable'))}>Finish turning off access</button>}
    </>}
  </section>;
}

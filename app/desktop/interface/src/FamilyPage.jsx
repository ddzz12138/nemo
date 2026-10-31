import React, { useEffect, useRef, useState } from 'react';
import './family.css';
import { FamilyReview } from './FamilyReview.jsx';

const CAPABILITIES = { memory: 'Memory', gmail: 'Gmail', calendar: 'Calendar', reminders: 'Leave reminders', research: 'Web research', browser: 'Browser', files: 'Files and uploads', terminal: 'Terminal and code', desktop: 'Desktop', tasks: 'Background tasks', agents: 'Subagents', schedule: 'Scheduling', voice: 'Voice', media: 'Images and video', extensions: 'Skills and connections', models: 'Model controls' };
const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
const dateTime = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** Account administration uses the existing profile APIs, never another person's data. */
export function FamilyPage({ api, session, onIdentityChange, onError }) {
  const identity = session.profile.id, owner = session.profile.role === 'owner';
  const [model, setModel] = useState(null), [selected, setSelected] = useState(identity), [devices, setDevices] = useState(null);
  const [name, setName] = useState(''), [child, setChild] = useState(false), [rename, setRename] = useState(null);
  const [reviewChild, setReviewChild] = useState(null);
  const [invite, setInvite] = useState(null), [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const identityRef = useRef(identity), epoch = useRef(0), deviceEpoch = useRef(0), lock = useRef(false), modelRevision = useRef(0);
  identityRef.current = identity;
  const current = (id, version) => identityRef.current === id && epoch.current === version;
  function report(problem, id, version) {
    if (!current(id, version)) return;
    setError(problem?.message || 'Nemo could not update your family. Try again.');
    if (problem?.status === 401 || problem?.code === 'PROFILE_CHANGED') onError?.(problem);
  }
  async function load(id, version) {
    const profiles = owner ? (await api.request('/api/profiles')).profiles : [session.profile];
    let reviews = [], reviewsUnavailable = false;
    if (session.profile.classification === 'child') {
      try { reviews = (await api.request('/api/family/review-log')).events; }
      catch (problem) { if (problem?.status === 401 || problem?.code === 'PROFILE_CHANGED') throw problem; reviewsUnavailable = true; }
    }
    if (!current(id, version)) return;
    setModel({ identity: id, profiles, reviews, reviewsUnavailable, revision: ++modelRevision.current });
    setSelected(previous => profiles.some(profile => profile.id === previous) ? previous : id);
  }
  useEffect(() => {
    const version = ++epoch.current;
    setModel(null); setDevices(null); setSelected(identity); setInvite(null); setReviewChild(null); setRename(null); setName(''); setChild(false); setNotice(''); setError(''); setBusy(false); lock.current = false;
    void load(identity, version).catch(problem => report(problem, identity, version));
    return () => { epoch.current++; deviceEpoch.current++; };
  }, [identity, owner, session.profile.name, session.profile.policyRevision, session.profile.childMode, session.profile.classification, session.profile.parentalReview]);
  useEffect(() => {
    setDevices(null);
    if (model?.identity !== identity || !model.profiles.some(profile => profile.id === selected)) return;
    const version = epoch.current, request = ++deviceEpoch.current;
    void api.request(`/api/profiles/${selected}/devices`).then(result => {
      if (current(identity, version) && request === deviceEpoch.current) setDevices({ identity, profileId: selected, ...result });
    }).catch(problem => { if (request === deviceEpoch.current) report(problem, identity, version); });
    return () => { deviceEpoch.current++; };
  }, [identity, selected, model?.revision]);
  useEffect(() => {
    if (!invite || invite.identity !== identity) return;
    const version = epoch.current;
    const timer = setTimeout(() => { if (current(identity, version)) { setInvite(null); setNotice('That invitation expired. Create another when you need it.'); } }, Math.max(0, invite.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [invite, identity]);
  async function perform(action, { refresh = true } = {}) {
    if (lock.current) return;
    const id = identity, version = epoch.current;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(() => current(id, version)); if (refresh && current(id, version)) await load(id, version); }
    catch (problem) { report(problem, id, version); }
    finally { if (current(id, version)) { lock.current = false; setBusy(false); } }
  }
  async function createInvite(profile, guard) {
    const value = await api.request(`/api/profiles/${profile.id}/invites`, {});
    if (guard()) setInvite({ ...value, identity });
  }
  const live = model?.identity === identity ? model : null;
  const shownInvite = invite?.identity === identity ? invite : null;
  const shownRename = rename?.identity === identity ? rename : null;
  const shownDevices = devices?.identity === identity && devices.profileId === selected ? devices.devices : null;

  return <section className="settings-page family-page" aria-labelledby="family-title">
    <div className="settings-intro"><h2 id="family-title">{owner ? 'Your family, each with their own Nemo.' : 'Your devices.'}</h2><p>{owner ? 'Separate conversations, memories and connected accounts.' : `${session.profile.name} · Your personal profile follows you across devices.`}</p></div>
    {error && <div className="family-message family-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void perform(() => Promise.resolve())}>Try again</button></div>}
    {notice && <p className="family-message" role="status">{notice}</p>}
    {shownInvite && <section className="family-invitation" aria-labelledby="family-invite-title"><div className="family-section-heading"><h3 id="family-invite-title">Invitation for {shownInvite.profile.name}</h3><button type="button" className="family-text-button" onClick={() => setInvite(null)}>Close</button></div><p>One use. Expires {dateTime(shownInvite.expiresAt)}. Share privately with this person.</p><code className="family-invite-code">{shownInvite.code}</code><button type="button" className="family-button" onClick={() => { void navigator.clipboard.writeText(shownInvite.code).then(() => { if (identityRef.current === identity) setNotice('Invitation copied. Share it privately.'); }, () => { if (identityRef.current === identity) setNotice('Select and copy the invitation code above.'); }); }}>Copy invitation</button><small>The other device must be able to reach your Nemo. Its connection is set up in this app’s Settings.</small></section>}
    {owner && <form className="family-create" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; void perform(async guard => { const result = await api.request('/api/profiles', { name: name.trim(), childMode: child }); if (!guard()) return; setName(''); setChild(false); setSelected(result.profile.id); setModel(previous => previous?.identity === identity ? { ...previous, profiles: [...previous.profiles.filter(profile => profile.id !== result.profile.id), result.profile], revision: ++modelRevision.current } : previous); await createInvite(result.profile, guard); }); }}><h3>Add someone</h3><div className="family-create-fields"><label className="family-name-label" htmlFor="family-new-name">Name<input id="family-new-name" value={name} maxLength={60} autoComplete="off" required disabled={busy} onChange={event => setName(event.target.value)} placeholder="Family member’s name" /></label><label className="family-check"><input type="checkbox" checked={child} disabled={busy} onChange={event => setChild(event.target.checked)} /><span>Child mode</span></label><button className="family-button family-button-primary" type="submit" disabled={busy || !live || !name.trim()}>Add family member</button></div><p className="quiet">Child mode offers hints and explanations, without completing homework. Visible family review starts on for child profiles. New profiles start empty.</p></form>}
    {!live ? <p className="quiet" role="status">{error ? 'Your family could not be loaded.' : 'Loading your family…'}</p> : <>
      <div className="family-section-heading"><h3>{owner ? 'Family profiles' : 'Your profile'}</h3><span className="quiet">{owner ? `${live.profiles.length} ${live.profiles.length === 1 ? 'person' : 'people'}` : 'Private to you'}</span></div>
      <div className="family-profile-list">{live.profiles.map(profile => <article key={profile.id} className={`family-profile ${selected === profile.id ? 'family-profile-selected' : ''}`}>
        <div className="family-profile-heading"><span className="family-avatar" aria-hidden="true">{profile.name.slice(0, 1)}</span><div><h4>{profile.name}{profile.id === identity && <span className="family-tag">You</span>}</h4><p>{profile.disabled ? 'Disabled · data preserved' : profile.role === 'owner' ? 'Home owner' : profile.classification === 'child' ? 'Child profile' : profile.classification === 'adult' ? 'Adult profile' : 'Personal profile'}</p></div></div>
        {shownRename?.id === profile.id ? <form className="family-rename" onSubmit={event => { event.preventDefault(); const nextName = shownRename.name.trim(); if (!nextName) return; void perform(async guard => { await api.request(`/api/profiles/${profile.id}/rename`, { name: nextName }); if (guard()) { setRename(null); if (profile.id === identity) onIdentityChange?.(); } }); }}><label className="sr-only" htmlFor={`rename-${profile.id}`}>Name for {profile.name}</label><input id={`rename-${profile.id}`} value={shownRename.name} maxLength={60} required disabled={busy} onChange={event => setRename({ ...shownRename, name: event.target.value })} autoFocus /><button type="submit" className="family-button" disabled={busy || !shownRename.name.trim()}>Save name</button><button type="button" className="family-text-button" disabled={busy} onClick={() => setRename(null)}>Cancel</button></form> : <div className="family-actions"><button type="button" className="family-text-button" aria-expanded={selected === profile.id} disabled={busy} onClick={() => setSelected(profile.id)}>Devices</button>{!profile.disabled && <button type="button" className="family-text-button" disabled={busy} onClick={() => void perform(guard => createInvite(profile, guard), { refresh: false })}>{profile.id === identity ? 'Add another device' : 'Create invitation'}</button>}{(owner || profile.id === identity) && <button type="button" className="family-text-button" disabled={busy} onClick={() => setRename({ id: profile.id, name: profile.name, identity })}>Rename</button>}{owner && profile.role !== 'owner' && <button type="button" className="family-text-button" disabled={busy} onClick={() => { if (!profile.disabled && !window.confirm(`Disable ${profile.name}? Their devices will be signed out. Their personal data stays saved.`)) return; void perform(async guard => { await api.request(`/api/profiles/${profile.id}/disabled`, { disabled: !profile.disabled }); if (guard()) setInvite(null); }); }}>{profile.disabled ? 'Enable profile' : 'Disable profile'}</button>}</div>}
        {owner && profile.role !== 'owner' && <details className="family-permissions"><summary>Profile and learning controls</summary><div className="family-classification"><span>Profile type</span><div className="family-actions"><button type="button" className="family-button" disabled={busy || profile.disabled || profile.classification === 'adult'} onClick={() => { if (window.confirm(`Classify ${profile.name} as an adult? This turns off Child mode. Additional PC tools still require verified isolation and setup.`)) void perform(() => api.request(`/api/profiles/${profile.id}/classification`, { classification: 'adult' })); }}>Adult</button><button type="button" className="family-button" disabled={busy || profile.disabled || profile.classification === 'child'} onClick={() => void perform(() => api.request(`/api/profiles/${profile.id}/classification`, { classification: 'child' }))}>Child</button></div></div><label className="family-check"><input type="checkbox" checked={profile.childMode === true} disabled={busy || profile.disabled} onChange={event => void perform(() => api.request(`/api/profiles/${profile.id}/child-mode`, { enabled: event.target.checked }))} /><span>Child mode · learning help, without doing the homework</span></label>{profile.classification === 'child' && <><label className="family-check"><input type="checkbox" checked={profile.parentalReview === true} disabled={busy || profile.disabled} onChange={event => { const enabled = event.target.checked; if (enabled && !window.confirm(`Turn on family review for ${profile.name}? They will see a notice that the home owner can review their chats and personal Memory.`)) return; void perform(() => api.request(`/api/profiles/${profile.id}/parental-review`, { enabled })); }} /><span>Visible family review of History and Memory</span></label><p className="quiet">{profile.parentalReview ? 'Family review is on and visible to this child.' : 'Family review is off.'} Children start with chat only. A tool permission does not connect an account or finish its setup.</p><details className="family-tools"><summary>Allowed tools</summary><div className="family-tool-grid">{Object.entries(CAPABILITIES).map(([capability, title]) => <label className="family-check" key={capability}><input type="checkbox" checked={profile.capabilityGrants?.[capability] === true} disabled={busy || profile.disabled} onChange={event => void perform(() => api.request(`/api/profiles/${profile.id}/capabilities`, { capability, enabled: event.target.checked }))} /><span>{title}</span></label>)}</div></details></>}</details>}
        {owner && profile.classification === 'child' && profile.parentalReview && !profile.disabled && <div className="family-review-entry"><button className="family-button" type="button" disabled={busy} aria-expanded={reviewChild?.identity === identity && reviewChild.childId === profile.id} onClick={() => setReviewChild({ identity, childId: profile.id })}>Review History &amp; Memory</button><small>Read only. This child can see your review activity.</small></div>}
        {owner && reviewChild?.identity === identity && reviewChild.childId === profile.id && profile.classification === 'child' && profile.parentalReview && !profile.disabled && <FamilyReview key={identity + '-' + profile.id + '-' + profile.policyRevision} api={api} owner={session.profile} child={profile} onClose={() => setReviewChild(null)} onError={onError} />}
        {selected === profile.id && <section className="family-devices" aria-label={`Devices for ${profile.name}`}><h5>Devices</h5>{!shownDevices ? <p className="quiet" role="status">Loading devices…</p> : !shownDevices.length ? <p className="quiet">No devices yet. Create a personal invitation to connect one.</p> : shownDevices.map(device => { const active = !device.revokedAt && device.expiresAt > Date.now(); return <div className="family-device" key={device.id}><div><strong>{device.name}{device.id === session.device.id && <span className="family-tag">This device</span>}</strong><p>{device.revokedAt ? 'Signed out' : !active ? 'Sign-in expired' : `Signed in until ${date(device.expiresAt)}`}</p></div>{active && <button type="button" className="family-text-button" disabled={busy} onClick={() => { if (!window.confirm(`Sign out ${device.name}? The profile and its personal data will stay saved.`)) return; void perform(async guard => { await api.request(`/api/devices/${device.id}/revoke`, {}); if (guard() && device.id === session.device.id) { setModel(null); setDevices(null); setInvite(null); onIdentityChange?.(); } }, { refresh: device.id !== session.device.id }); }}>Sign out device</button>}</div>; })}</section>}
      </article>)}</div>
      {session.profile.classification === 'child' && <section className="family-review-activity"><h3>Family review activity</h3><p className="quiet">{session.profile.parentalReview ? 'Your home owner can review your chats and personal Memory. Reviews appear here.' : 'Family review is off. Earlier review activity remains visible below.'}</p>{live.reviewsUnavailable ? <p className="quiet">Review activity could not be loaded. Your devices are still available above.</p> : !live.reviews.length ? <p className="quiet">No reviews recorded yet.</p> : <ul>{live.reviews.slice(0, 10).map((event, index) => <li key={`${event.at}-${index}`}>{event.reviewer} viewed {event.kind === 'memory' ? 'personal Memory' : 'chat history'} · {dateTime(event.at)}</li>)}</ul>}</section>}
    </>}
    {owner && <p className="quiet family-privacy-note">Managing a profile gives you account controls. It does not open another adult’s conversations, memories or connected accounts.</p>}
  </section>;
}

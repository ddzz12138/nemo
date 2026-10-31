import React, { useEffect, useRef, useState } from 'react';
import { SetupFlow } from './Setup.jsx';

export function ConnectionsPage({ api, session, onError, onNavigate }) {
  const [tab, setTab] = useState('connections'), [connections, setConnections] = useState(null), [gmail, setGmail] = useState(null), [calendar, setCalendar] = useState(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef(false), person = useRef(session.profile.id), revision = useRef(0), lock = useRef(false);
  person.current = session.profile.id;
  async function load() {
    const version = ++revision.current, id = person.current;
    const value = await api.integrations(); if (!active.current || version !== revision.current || id !== person.current) return;
    setConnections(value);
    if (value.gmail?.restricted) { setGmail(null); return; }
    try { const result = await api.gmail(); if (active.current && version === revision.current && id === person.current) setGmail(result); }
    catch (problem) { if (!active.current || version !== revision.current || id !== person.current) return; if ([401, 409].includes(problem.status)) onError(problem); else setNotice('Gmail is optional. You can keep using Nemo without it.'); }
  }
  useEffect(() => {
    active.current = true; const id=person.current;
    const reload=()=>{if(!active.current||lock.current||document.hidden)return;const ticket=revision.current+1;void load().catch(problem=>{if(active.current&&id===person.current&&ticket===revision.current)onError(problem);});};
    setConnections(null); setGmail(null); setCalendar(null);reload();
    window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);
    return () => { active.current = false; revision.current++;window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload); };
  }, [session.profile.id]);
  useEffect(() => {
    if (gmail?.desktop?.phase !== 'waiting') return;
    const timer = setInterval(() => {
      if (!active.current || lock.current || document.hidden) return;
      const id = person.current;
      void load().catch(problem => { if (active.current && id === person.current) onError(problem); });
    }, 1500);
    return () => clearInterval(timer);
  }, [gmail?.desktop?.phase, session.profile.id]);
  async function act(operation) {
    if (lock.current) return; lock.current = true; revision.current++; const id = person.current; setBusy(true); setNotice('');
    try { await operation(() => active.current && id === person.current); if (active.current && id === person.current) await load(); }
    catch (problem) { if (active.current && id === person.current) { setNotice(problem.message || 'Nemo could not update this connection.'); if ([401, 409].includes(problem.status)) onError(problem); } }
    finally { lock.current = false; if (active.current && id === person.current) setBusy(false); }
  }
  return <section className="settings-page"><div className="settings-intro"><h2>Settings</h2><p>Your space, accounts and permissions.</p></div><nav className="settings-tabs" aria-label="Settings sections"><button className={tab === 'connections' ? 'active' : ''} onClick={() => setTab('connections')}>Your connections</button>{session.profile.role === 'owner' && window.nemoDesktop && <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>This PC & ChatGPT</button>}<button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>About</button></nav>
    {notice && <p className="inline-error" role="status">{notice}</p>}
    {tab === 'home' && session.profile.role === 'owner' ? <SetupFlow key={session.profile.id} profileId={session.profile.id} embedded /> : tab === 'about' ? <><div className="connection-row"><div><h3>Nemo</h3><p>Built on Hermes. An interface for your family.</p><small>Ollama-derived desktop layout · Open source components.</small></div><a href="/vendor/ollama-LICENSE.txt" target="_blank" rel="noopener noreferrer">Ollama licence ↗</a></div><p className="quiet">Profiles, chats and saved information live on your home PC. Relevant context goes to ChatGPT to answer a request. Keep this PC awake for family devices.</p></> : <>
      <div className="connection-row"><div><h3>{session.profile.name}</h3><p>{session.profile.childMode ? 'Child mode' : 'Personal profile'} · Your own chats, accounts and Memory.</p></div><button className="app-button" onClick={() => onNavigate('family')}>Manage devices</button></div>
      {session.profile.role !== 'owner' && <div className="connection-row"><div><h3>ChatGPT</h3><p>{session.connected ? 'Connected to this home' : 'Your family owner needs to connect the home’s assistant.'}</p><small>Your private context stays separate. The family owner manages the shared AI connection.</small></div></div>}
      <div className="connection-row"><div><h3>Gmail</h3><p>{connections?.gmail?.restricted ? 'Your family owner can enable Gmail for your profile.' : gmail?.gmail?.connected ? gmail.gmail.account || 'Connected to your private profile' : 'Not connected · Optional'}</p><small>Sign in with Google. Read-only access, saved to your profile on this PC.</small>{gmail?.desktop?.phase === 'waiting' ? <p role="status">Finish signing in in your browser. Then return to Nemo.</p> : gmail?.desktop?.message ? <p role="status">{gmail.desktop.message}</p> : gmail && !gmail.desktop?.available && !connections?.gmail?.restricted ? <p className="quiet">{window.nemoShell ? 'Google sign-in is not included in this Nemo build yet.' : 'Connect Gmail in the Nemo app on your home PC.'}</p> : null}</div><div className="setting-actions">{gmail?.desktop?.phase === 'waiting' ? <button className="app-button" disabled={busy} onClick={() => void act(() => window.nemoShell.cancelGmail(session.profile.id))}>Cancel sign-in</button> : <button className="app-button" disabled={busy || !window.nemoShell?.connectGmail || !gmail?.desktop?.available || !!connections?.gmail?.restricted} onClick={() => void act(() => window.nemoShell.connectGmail(session.profile.id))}>{gmail?.gmail?.connected ? 'Change account' : gmail?.desktop?.phase === 'error' ? 'Try again' : 'Connect Gmail'}</button>}{gmail?.gmail?.connected && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm('Disconnect Gmail from your profile? Your emails stay in Google.')) void act(() => api.disconnectGmail()); }}>Disconnect</button>}</div></div>
      <div className="connection-row"><div><h3>Calendar</h3><p>{connections?.calendar?.restricted ? 'Your family owner can enable calendar access.' : connections?.calendar?.connected ? 'Connected to your private profile' : 'Not connected · Optional'}</p><small>Use a personal sync token to send your iPhone calendar to Nemo.</small></div><div className="setting-actions"><button className="app-button" disabled={busy || !connections || !!connections.calendar?.restricted} onClick={() => void act(async current => { const result = await api.request('/api/calendar/token', {}); if (current()) setCalendar(result); })}>{calendar ? 'New sync token' : 'Set up calendar'}</button>{connections?.calendar?.connected && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm('Disconnect your calendar? Its snapshot and upload token will be removed from your profile.')) void act(async current => { await api.request('/api/calendar/disconnect', {}); if (current()) setCalendar(null); }); }}>Disconnect</button>}</div></div>
      {calendar && <div className="plan-notice"><strong>Your personal calendar connection</strong><p>In the iPhone shortcut “{calendar.shortcutName || 'Nemo Sync Calendar'}”, use this endpoint and token. Keep the token private; it only updates your calendar.</p><label className="secret-field">Upload address<input readOnly value={calendar.endpoint || ''} /></label><label className="secret-field">Personal upload token<input readOnly value={calendar.token || ''} /></label>{calendar.notice && <p>{calendar.notice}</p>}</div>}
      <div className="connection-row"><div><h3>Use my connected accounts</h3><p>Nemo uses the tools you enable automatically.</p><small>Relevant information may be sent to ChatGPT for replies.</small></div><label className="toggle-label"><input type="checkbox" aria-label="Use my connected accounts" checked={connections?.contextConsent === true} disabled={busy || !connections} onChange={event => { const enabled = event.target.checked; void act(() => api.consent(enabled)); }} /><span>{connections?.contextConsent ? 'On' : 'Off'}</span></label></div>
      <div className="connection-row"><div><h3>Sign out this device</h3><p>Your saved chats and profile stay on the home PC.</p></div><button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Sign this device out of ${session.profile.name}’s profile?`)) void act(() => api.request('/api/logout', {})); }}>Sign out</button></div>
    </>}
  </section>;
}

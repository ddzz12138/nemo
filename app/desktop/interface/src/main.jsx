import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarLayout } from './Layout.jsx';
import { AssistantText } from './AssistantText.jsx';
import { createDesktopApi, activityLabel, createViewGate } from '../../../public/desktop-api.mjs';
import { SetupFlow } from './Setup.jsx';
import { Pairing } from './Pairing.jsx';
import { ConnectionsPage } from './ConnectionsPage.jsx';
import { FamilyPage } from './FamilyPage.jsx';
import { MemoryPage } from './MemoryPage.jsx';
import { SchoolNoticePage } from './SchoolNoticePage.jsx';
import { ActivityLog } from './ActivityLog.jsx';
import { takeDesktopRoute } from '../../../public/desktop-route.mjs';
import './styles.css';

function Icon({ name }) {
  const paths = { chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2M12 2v2m0 16v2M2 12h2m16 0h2', arrow: 'M12 19V5m-6 6 6-6 6 6', memory: 'M12 3v18M3 12h18M6 6l12 12M6 18 18 6', family: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8m6 10v-2a4 4 0 0 0-3-3.9M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.chat} /></svg>;
}
const pendingKey = id => `nemo.desktop.pending.v1.${id}`;
const draftKey = (profileId, conversationId) => `nemo.desktop.draft.v1.${profileId}.${conversationId}`;
function savedDraft(profileId, conversationId) { try { return (sessionStorage.getItem(draftKey(profileId, conversationId)) || '').slice(0, 8000); } catch { return ''; } }
function rememberDraft(profileId, conversationId, value) { if (!profileId || !conversationId) return; try { value ? sessionStorage.setItem(draftKey(profileId, conversationId), value) : sessionStorage.removeItem(draftKey(profileId, conversationId)); } catch {} }
function savedPending(id) { try { const value = JSON.parse(sessionStorage.getItem(pendingKey(id))); return value?.profileId === id && /^[a-f0-9-]{36}$/i.test(value.requestId) && typeof value.message === 'string' ? value : null; } catch { return null; } }
function rememberPending(id, value) { try { value ? sessionStorage.setItem(pendingKey(id), JSON.stringify(value)) : sessionStorage.removeItem(pendingKey(id)); } catch { /* A live session still works when browser storage is unavailable. */ } }

const setupDocument = ['/setup/', '/setup', '/host-setup.html'].includes(window.location.pathname);
const entryRoute=setupDocument?{page:'chat',invitation:null}:takeDesktopRoute(window.location,window.history);
const initialInvitation=entryRoute.invitation,initialPage=entryRoute.page;

function App() {
  const [session, setSession] = useState(null), [page, setPage] = useState(initialPage), [messages, setMessages] = useState([]), [histories, setHistories] = useState([]), [conversationId, setConversationId] = useState(null), [invitation, setInvitation] = useState(initialInvitation);
  const [draft, setDraft] = useState(''), [run, setRun] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [pending, setPending] = useState(null);
  const profile = useRef(null), generation = useRef(0), end = useRef(null), scrollArea = useRef(null), follow = useRef(true), apiRef = useRef(null), sendLock = useRef(false), viewGate = useRef(createViewGate());
  const conversation = useRef(null), composer = useRef(null);
  const pairing = useRef(false); pairing.current = invitation !== null || !loading && !session?.authenticated;
  if (!apiRef.current) apiRef.current = createDesktopApi({ fetchImpl: (...args) => window.nemoFetch(...args), getProfile: () => profile.current, getEpoch: () => window.NemoIdentity.epoch });
  const api = apiRef.current;
  const fail = problem => { setError(problem?.message || 'Nemo could not reach your computer. Try again.'); if (problem?.status === 401 || problem?.code === 'PROFILE_CHANGED') { generation.current++; profile.current = null; conversation.current = null; setConversationId(null); setSession(null); setMessages([]); setHistories([]); setRun(null); setDraft(''); setPending(null); } };
  function showConversation(data) {
    const changed = conversation.current !== data.conversationId;
    if (changed) { generation.current++; conversation.current = data.conversationId; setConversationId(data.conversationId); setDraft(savedDraft(profile.current.id, data.conversationId)); follow.current = true; }
    const restored = savedPending(profile.current.id);
    if (restored && !restored.conversationId) { restored.conversationId = data.conversationId; rememberPending(profile.current.id, restored); }
    setPending(restored);
    if (restored) { setDraft(restored.message); if (restored.conversationId !== data.conversationId) setError('Your last message belongs to another chat. Open that chat from your history to check it.'); }
    setMessages(data.messages || []); setRun(previous => data.activeRunId ? previous?.id === data.activeRunId ? previous : { id: data.activeRunId, status: 'running' } : null);
  }
  async function loadConversation(version = generation.current, ticket = viewGate.current.begin()) {
    const data = await api.conversation(); if (version !== generation.current || !viewGate.current.current(ticket)) return;
    showConversation(data); const selectedVersion = generation.current;
    const history = await api.history(); if (selectedVersion === generation.current && viewGate.current.current(ticket)) setHistories((history.conversations || []).filter(item => item.source !== 'native' && item.count > 0));
  }
  async function refresh() {
    const ticket = viewGate.current.begin();
    setLoading(true); setError('');
    try {
      const next = await api.session();
      if (!viewGate.current.current(ticket)) return;
      if (profile.current?.id !== next.profile?.id) { generation.current++; conversation.current = null; setConversationId(null); setMessages([]); setHistories([]); setRun(null); setDraft(''); }
      profile.current = next.profile || null; setSession(next);
      if (!next.authenticated) return;
      const version = generation.current; await loadConversation(version, ticket);
    } catch (problem) { if(viewGate.current.current(ticket))fail(problem); } finally { if(viewGate.current.current(ticket))setLoading(false); }
  }
  useEffect(() => { if (!pairing.current) void refresh(); const onFocus = () => { if (!pairing.current && document.visibilityState === 'visible' && !sendLock.current) void refresh(); }; window.addEventListener('focus', onFocus); return () => { generation.current++; window.removeEventListener('focus', onFocus); }; }, []);
  useEffect(()=>{
    const changed=()=>{const route=takeDesktopRoute(window.location,window.history);if(route.invitation!==null){pairing.current=true;generation.current++;viewGate.current.begin();setRun(null);setInvitation(route.invitation);}else navigate(route.page);};
    window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);
  },[]);
  useEffect(() => { if (follow.current) end.current?.scrollIntoView({ block: 'end', behavior: 'instant' }); }, [messages, run?.text]);
  useEffect(() => {
    if (!run?.id || !profile.current) return;
    let disposed = false, timer, failures = 0; const version = generation.current;
    async function poll() {
      if (disposed || version !== generation.current) return;
      if (document.visibilityState === 'hidden') { timer = setTimeout(poll, 1500); return; }
      try {
        const result = await api.run(run.id); if (disposed || version !== generation.current) return;
        failures = 0; setRun(result);
        if (['completed', 'failed', 'cancelled'].includes(result.status)) { await loadConversation(version); if (result.error) setError(result.error); return; }
      } catch (problem) { if (disposed || version !== generation.current) return; fail(problem); if (++failures >= 5 || [401, 404, 409].includes(problem.status)) return; }
      if (!disposed) timer = setTimeout(poll, 850);
    }
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [run?.id]);
  async function send(event, workflow) {
    event?.preventDefault(); if (sendLock.current || busy || run || !profile.current || !conversation.current || !workflow && !draft.trim()) return;
    const person = profile.current, version = generation.current, ticket = viewGate.current.begin();
    const submission = pending || { profileId: person.id, conversationId: conversation.current, requestId: crypto.randomUUID(), message: workflow ? 'Brief my selected school notice.' : draft.trim(), ...(workflow ? { workflow } : {}) };
    if (submission.conversationId !== conversation.current) { setError('Open the original chat from your history to check your last message.'); return; }
    sendLock.current = true; setBusy(true); setError(''); setPending(submission); rememberPending(person.id, submission);
    try {
      const accepted = await api.send(submission.message, submission.requestId, submission.conversationId, submission.workflow); if (version !== generation.current) return;
      rememberPending(person.id, null); setPending(null); if (submission.workflow) setDraft(savedDraft(person.id, submission.conversationId)); else { rememberDraft(person.id, submission.conversationId, ''); setDraft(''); } follow.current = true;
      // Retain the accepted task even if the secondary history read is unavailable.
      setRun({ id: accepted.runId, status: 'queued', text: '' });
      setPage('chat');
      const data = await api.conversation(); if (version !== generation.current || !viewGate.current.current(ticket)) return;
      setMessages(data.messages || []);
    } catch (problem) { if (version !== generation.current) return; if (problem.status >= 400 && problem.status < 500 && ![408, 429].includes(problem.status) && problem.code !== 'CONVERSATION_CHANGED') { rememberPending(person.id, null); setPending(null); } fail(problem); }
    finally { sendLock.current = false; setBusy(false); }
  }
  async function changeChat(id = null) {
    if (sendLock.current || busy || run || !profile.current || !conversation.current || pending && id !== pending.conversationId) return;
    const version = generation.current, from = conversation.current, ticket = viewGate.current.begin();
    sendLock.current = true; setBusy(true); setError('');
    try {
      const result = id ? await api.openConversation(id, from) : await api.newConversation(from);
      if (version !== generation.current || !viewGate.current.current(ticket)) return;
      if (!id && result.conversationId === from) { rememberDraft(profile.current.id, from, ''); setDraft(''); }
      showConversation(result); setPage('chat'); const selectedVersion = generation.current;
      const history = await api.history(); if (selectedVersion === generation.current && viewGate.current.current(ticket)) setHistories((history.conversations || []).filter(item => item.source !== 'native' && item.count > 0));
      requestAnimationFrame(() => composer.current?.focus());
    } catch (problem) { if (version === generation.current) { fail(problem); if (problem.code === 'CONVERSATION_CHANGED') await loadConversation(); } }
    finally { sendLock.current = false; setBusy(false); }
  }
  const activeMessages = messages;
  function navigate(next) { setError(''); setPage(next); }
  if (invitation !== null || !loading && !session?.authenticated) return <Pairing invitation={invitation || ''} onConnected={() => { setInvitation(null); void refresh(); }} />;
  const sidebar = <><nav className="primary-navigation"><button className={page === 'chat' && !messages.length ? 'active' : ''} disabled={busy || !!run || !!pending || !conversationId} title={run ? 'Wait for Nemo’s reply before starting a new chat' : 'Start a new chat'} onClick={() => void changeChat()}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New Chat</button><button className={page === 'school' ? 'active' : ''} onClick={() => navigate('school')}><Icon name="chat" />School notice</button><button className={page === 'memory' ? 'active' : ''} onClick={() => navigate('memory')}><Icon name="memory" />Memory</button><button className={page === 'family' ? 'active' : ''} onClick={() => navigate('family')}><Icon name="family" />{session?.profile?.role === 'owner' ? 'Family' : 'My devices'}</button></nav><div className="history-heading">Your conversations</div><div className="history-list">{histories.length ? histories.map(item => <button key={item.id} className={page === 'chat' && conversationId === item.id ? 'active' : ''} aria-current={page === 'chat' && conversationId === item.id ? 'page' : undefined} disabled={busy || !!run || !!pending && pending.conversationId !== item.id} onClick={() => void changeChat(item.id)} title={item.title || 'Saved conversation'}>{item.title || 'Saved conversation'}</button>) : <p className="quiet sidebar-empty">Your conversations will appear here.</p>}</div></>;
  return <SidebarLayout title={page === 'school' ? 'School notice' : page === 'settings' ? 'Settings' : page === 'family' ? 'Family' : page === 'memory' ? 'Memory' : 'Nemo'} profile={session?.profile} sidebar={session?.authenticated ? sidebar : null} sidebarFooter={<button className={`settings-button ${page === 'settings' ? 'active' : ''}`} disabled={!session?.authenticated} onClick={() => navigate('settings')}><Icon name="settings" />Settings</button>}>
    {error && <div className="error-notice" role="alert"><span>{error}</span><button onClick={() => void refresh()}>Reconnect</button></div>}
    {loading && !session ? <div className="empty-state" role="status">Opening your Nemo space…</div> : page === 'settings' ? <ConnectionsPage key={session.profile.id} api={api} session={session} onError={fail} onNavigate={navigate} /> : page === 'family' ? <FamilyPage key={session.profile.id} api={api} session={session} onError={fail} onIdentityChange={() => void refresh()} /> : page === 'school' ? <SchoolNoticePage key={session.profile.id} api={api} session={session} disabled={busy || !!run || !!pending || !conversationId} onStart={workflow => send(null, workflow)} onNavigate={navigate} /> : page === 'memory' ? <MemoryPage key={session.profile.id} api={api} session={session} onError={fail} /> : <><div className="chat-scroll" ref={scrollArea} onScroll={() => { const node = scrollArea.current; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="chat-column">
      {!activeMessages.length && !run ? <div className="chat-welcome"><span className="nemo-spark" aria-hidden="true">✳</span><h2>Hello, {session.profile.name}.</h2><p>What’s on your mind?</p></div> : <div className="message-list" role="log" aria-label="Conversation">{activeMessages.map((message, index) => <article key={message.id || index} className={`message message-${message.role}`}><span className="sr-only">{message.role === 'user' ? session.profile.name : 'Nemo'}: </span><div className="message-text">{message.role === 'user' ? message.text : <AssistantText text={message.text} />}</div><ActivityLog activity={message.activity} /></article>)}{run && <article className="message message-assistant"><div className="message-text">{run.text ? <AssistantText text={run.text} /> : <span className="activity" role="status"><span className="activity-dot" />{activityLabel(run.activity)}</span>}</div><ActivityLog activity={run.activity} /></article>}</div>}
      <div ref={end} /></div></div><div className="composer-area"><form className="chat-composer" onSubmit={send}><label className="sr-only" htmlFor="desktop-message">Message Nemo</label><textarea id="desktop-message" ref={composer} placeholder="Message Nemo" value={draft} maxLength={8000} disabled={busy || !!pending || !conversationId} rows="2" onChange={event => { setDraft(event.target.value); rememberDraft(profile.current.id, conversation.current, event.target.value); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} /><div className="composer-bottom"><span>{session.profile.childMode ? 'Child mode' : 'Your personal Nemo'}</span><button className="send-button" type="submit" aria-label={pending ? 'Check last message' : 'Send message'} title={pending ? 'Check last message' : 'Send message'} disabled={busy || !!run || !conversationId || !draft.trim()}><Icon name="arrow" /></button></div></form><p className="composer-caption">{pending ? 'Your last send needs confirmation. Send again to check it safely.' : session.planUsage?.enabled ? <><span>Using ChatGPT plan</span> · <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a></> : session.inference?.localOnly ? 'Using local Gemma 4 12B · Replies stay on this PC.' : 'Powered by Nemo · Replies can make mistakes.'}</p></div></>}
  </SidebarLayout>;
}
createRoot(document.getElementById('nemo-desktop')).render(setupDocument ? <SetupFlow /> : <App />);

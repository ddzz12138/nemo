import React, { useEffect, useRef, useState } from 'react';
import './memory-page.css';

const TOPICS = { personal: 'About you', preferences: 'Preferences', projects: 'Projects', people: 'People' };
const titleOf = text => text.replace(/\s+/g, ' ').trim().slice(0, 90);

export function MemoryPage({ api, session, onError }) {
  const profileId = session?.profile?.id;
  const identity = useRef(profileId), mounted = useRef(false), revision = useRef(0), mutation = useRef(null), dialog = useRef(null), opener = useRef(null);
  identity.current = profileId;
  const [snapshot, setSnapshot] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [problem, setProblem] = useState(''), [query, setQuery] = useState(''), [topic, setTopic] = useState('all'), [sheet, setSheet] = useState(null);
  const board = snapshot?.profileId === profileId ? snapshot.board : null;
  const visibleSheet = sheet?.profileId === profileId ? sheet : null;
  const current = owner => mounted.current && identity.current === owner;
  function report(error, owner = profileId) {
    if (!current(owner)) return;
    setProblem(error?.message || 'Your memories could not be read. Try again.');
    if (error?.status === 401 || error?.code === 'PROFILE_CHANGED') onError?.(error);
  }
  async function refresh(owner = profileId) {
    const ticket = ++revision.current;
    try {
      const value = await api.request('/api/memory/board');
      if (!current(owner) || ticket !== revision.current) return;
      setSnapshot({ profileId: owner, board: value }); setProblem('');
      if (typeof value.notice === 'string') setNotice(value.notice);
    } catch (error) { if (ticket === revision.current) report(error, owner); }
    finally { if (current(owner) && ticket === revision.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; mutation.current = null; setBusy(false); setSnapshot(null); setSheet(null); setNotice(''); setProblem(''); setQuery(''); setTopic('all'); setLoading(true);
    const visible = () => { if (document.visibilityState === 'visible' && !mutation.current) void refresh(profileId); };
    document.addEventListener('visibilitychange', visible);
    void refresh(profileId);
    return () => { mounted.current = false; revision.current++; document.removeEventListener('visibilitychange', visible); };
  }, [profileId, api]);
  useEffect(() => {
    if (!board?.learning?.busy) return;
    const owner = profileId, timer = setTimeout(() => { if (document.visibilityState === 'visible' && !mutation.current) void refresh(owner); }, 4000);
    return () => clearTimeout(timer);
  }, [board, profileId]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (visibleSheet) {
      if (!node.open) { opener.current = document.activeElement; node.showModal(); }
      (node.querySelector('textarea') || node.querySelector('button'))?.focus();
    } else if (node.open) { node.close(); opener.current?.focus?.(); }
  }, [visibleSheet?.mode, !!visibleSheet]);
  async function act(work) {
    if (mutation.current) return;
    const owner = profileId, operation = Symbol('memory action'); mutation.current = operation; setBusy(true); setProblem(''); setNotice('');
    try { await work(owner); }
    catch (error) { report(error, owner); }
    finally { if (mutation.current === operation) { mutation.current = null; if (current(owner)) setBusy(false); } }
  }
  async function edit(item) {
    await act(async owner => {
      const detail = item ? await api.request('/api/memory/fact?id=' + encodeURIComponent(item.id)) : null;
      if (!current(owner)) return;
      setSheet({ profileId: owner, mode: 'editor', id: detail?.item?.id || '', revision: detail?.item?.revision || '', content: detail?.item?.content || '', category: item?.category || 'personal', forgotten: detail?.item?.status === 'forgotten', evidence: detail?.evidence || '', sourceLabel: detail?.sourceLabel || '' });
    });
  }
  async function save(event) {
    event.preventDefault(); const entry = visibleSheet;
    if (entry?.mode !== 'editor' || !entry.content.trim() || entry.forgotten) return;
    await act(async owner => {
      const content = entry.content.trim();
      const value = await api.request(entry.id ? '/api/memory/edit' : '/api/memory/notes', { ...(entry.id ? { id: entry.id, revision: entry.revision } : {}), title: titleOf(content), content, category: entry.category });
      if (!current(owner)) return;
      setSheet(null); setNotice(value.notice || 'Memory saved.'); await refresh(owner);
    });
  }
  async function review(item, action) {
    await act(async owner => {
      const result = await api.request('/api/memory/delete/preview', { id: item.id, action });
      if (current(owner)) setSheet({ profileId: owner, mode: 'review', action, review: result, previous: visibleSheet });
    });
  }
  async function confirmChange() {
    const entry = visibleSheet; if (entry?.mode !== 'review') return;
    if (Date.now() >= Number(entry.review.expiresAt)) { setProblem('This review expired. Cancel and review the change again.'); return; }
    await act(async owner => {
      const result = await api.request('/api/memory/delete', { confirmation: entry.review.confirmation });
      if (!current(owner)) return;
      setSheet(null); setNotice(result.receipt?.message || 'Memory updated.'); await refresh(owner);
    });
  }
  function cancelSheet() { if (!busy) setSheet(visibleSheet?.mode === 'review' ? visibleSheet.previous || null : null); }
  const items = Array.isArray(board?.items) ? board.items : [];
  const active = items.filter(item => item.status !== 'forgotten');
  const filtered = items.filter(item => (topic === 'forgotten' ? item.status === 'forgotten' : item.status !== 'forgotten' && (topic === 'all' || item.category === topic)) && (!query.trim() || `${item.title || ''} ${item.text || ''}`.toLowerCase().includes(query.trim().toLowerCase())));
  const references = Array.isArray(board?.references?.gmail) ? board.references.gmail : [];
  return <section className="desktop-memory settings-page" aria-label="Your personal Memory">
    <div className="settings-intro"><h2>A little more you.</h2><p>What Nemo remembers for {session?.profile?.name || 'you'}. Yours to correct or remove.</p></div>
    {problem && <div className="memory-inline-notice" role="alert"><p>{problem}</p><button onClick={() => { setLoading(true); void refresh(); }} disabled={busy}>Try again</button></div>}
    {notice && <p className="memory-inline-notice" role="status">{notice}</p>}
    {loading && !board ? <p className="quiet" role="status">Loading your memories…</p> : !board ? <div className="memory-empty-state"><h3>Memory is unavailable.</h3><p>Your conversations are still saved in Chat. Try again when the Memory connection is ready.</p></div> : <>
      <section className="memory-summary-panel" aria-labelledby="desktop-memory-summary"><h3 id="desktop-memory-summary">About you</h3>{board.summary?.segments?.length ? <p>{board.summary.segments.map(item => item.text).join(' ')}</p> : <p className="quiet">The useful details you save will build a picture of you here.</p>}<p className="quiet">{board.summary?.sourceCount ? `Drawn from ${board.summary.sourceCount} saved ${board.summary.sourceCount === 1 ? 'memory' : 'memories'}.` : 'Your summary comes from saved memories.'}{board.hasMore ? ' This is part of your collection.' : ''}</p></section>
      <div className="setting-row"><div><h3>Learn from my conversations</h3><p>Keep useful, lasting details as you talk.</p><small>Learning runs on this PC. Retrieved memories can be included in AI replies when your connected-account permission is on.</small>{board.learning?.error && <small role="status">{board.learning.error}</small>}{board.learning?.busy && <small role="status">Reviewing the useful parts of your conversation…</small>}</div><label className="toggle-label"><input type="checkbox" aria-label="Learn from my conversations" checked={board.learning?.enabled === true} disabled={busy || !board.connected} onChange={event => { const enabled = event.target.checked; void act(async owner => { await api.request('/api/memory/learning', { enabled }); if (current(owner)) await refresh(owner); }); }} /><span>{board.learning?.enabled ? 'On' : 'Off'}</span></label></div>
      {!board.connected && <div className="setting-row"><div><h3>Connect local Memory</h3><p>Your Memory store is not connected yet.</p><small>Chat can continue without it.</small></div><button className="memory-action" disabled={busy} onClick={() => void act(async owner => { await api.request('/api/memory/enable', {}); if (current(owner)) await refresh(owner); })}>Enable local Memory</button></div>}
      <div className="memory-list-heading"><div><h3>Saved details <span className="quiet">{active.length}</span></h3><p className="quiet">From your conversations and the things you choose to save.</p></div><button className="memory-action" disabled={busy || !board.connected} onClick={() => void edit(null)}>Add a memory</button></div>
      <label className="sr-only" htmlFor="desktop-memory-search">Find a saved memory</label><input id="desktop-memory-search" className="memory-search" type="search" value={query} maxLength={500} placeholder="Find a memory" onChange={event => setQuery(event.target.value)} />
      <div className="memory-topic-filter" role="group" aria-label="Memory topics">{Object.entries({ all: 'All', ...TOPICS, forgotten: 'Not used' }).map(([key, label]) => <button key={key} aria-pressed={topic === key} onClick={() => setTopic(key)}>{label}</button>)}</div>
      <div className="desktop-memory-list">{filtered.length ? filtered.map(item => <article key={item.id} className="desktop-memory-item"><div><p>{item.text || item.title}</p><small>{TOPICS[item.category] || 'Memory'} · {item.status === 'forgotten' ? 'Not used for recall' : item.corrected ? 'Corrected by you' : item.sourceLabel || 'Saved by you'}</small></div><button disabled={busy} onClick={() => void edit(item)} aria-label={'View memory: ' + (item.title || item.text)}>View</button></article>) : <p className="quiet memory-list-empty">{query ? 'No matching memories. Try different words.' : topic === 'forgotten' ? 'No memories are paused.' : 'Nothing here yet. Add a detail you want Nemo to remember.'}</p>}</div>
      {references.length > 0 && <details className="memory-email-references"><summary>{references.length} email {references.length === 1 ? 'reference' : 'references'}</summary><p className="quiet">These snippets are kept separately from saved details and your summary.</p>{references.map(item => <details key={item.id}><summary>{item.title || 'Email reference'}</summary><p>{item.text}</p></details>)}</details>}
      <p className="quiet memory-storage-note">Personal to this profile. Saved memories live in its separate GBrain store on this PC. Removing a memory does not erase the original conversation, email or backups.</p>
    </>}
    <dialog ref={dialog} className="desktop-memory-dialog" aria-labelledby="desktop-memory-dialog-title" onCancel={event => { event.preventDefault(); cancelSheet(); }}>
      {visibleSheet?.mode === 'editor' ? <><div className="memory-dialog-heading"><h3 id="desktop-memory-dialog-title">{visibleSheet.id ? 'A saved detail' : 'Add a memory'}</h3><button disabled={busy} onClick={cancelSheet} aria-label="Close memory editor">Close</button></div><form onSubmit={save}><label htmlFor="desktop-memory-content">Memory</label><textarea id="desktop-memory-content" autoFocus value={visibleSheet.content} maxLength={Math.max(800, visibleSheet.content.length)} rows={5} required disabled={busy || visibleSheet.forgotten} onChange={event => setSheet({ ...visibleSheet, content: event.target.value })} /><label htmlFor="desktop-memory-category">Topic</label><select id="desktop-memory-category" value={visibleSheet.category} disabled={busy || visibleSheet.forgotten} onChange={event => setSheet({ ...visibleSheet, category: event.target.value })}>{Object.entries(TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{visibleSheet.evidence && <details><summary>Where this came from</summary><p className="quiet">{visibleSheet.sourceLabel}: “{visibleSheet.evidence}”</p></details>}{problem && <p className="memory-inline-notice" role="alert">{problem}</p>}<div className="memory-dialog-actions">{!visibleSheet.forgotten && <button className="memory-action" type="submit" disabled={busy || !visibleSheet.content.trim()}>Save memory</button>}{visibleSheet.id && <>{!visibleSheet.forgotten && <button type="button" disabled={busy} onClick={() => void review(visibleSheet, 'forget')}>Stop using</button>}<button className="memory-remove" type="button" disabled={busy} onClick={() => void review(visibleSheet, 'delete')}>Delete</button></>}</div></form></> : visibleSheet?.mode === 'review' ? <><h3 id="desktop-memory-dialog-title">Review this change</h3><p>{visibleSheet.review.summary}</p><ul className="quiet">{(visibleSheet.review.residuals || []).map((text, index) => <li key={index}>{text}</li>)}</ul>{problem && <p className="memory-inline-notice" role="alert">{problem}</p>}<div className="memory-dialog-actions"><button className="memory-action memory-remove" disabled={busy} onClick={() => void confirmChange()}>{visibleSheet.action === 'forget' ? 'Stop using memory' : 'Confirm delete'}</button><button disabled={busy} onClick={cancelSheet}>Cancel</button></div></> : null}
    </dialog>
  </section>;
}

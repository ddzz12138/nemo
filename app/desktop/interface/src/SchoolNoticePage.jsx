import React, { useEffect, useRef, useState } from 'react';
import './SchoolNoticePage.css';

export function SchoolNoticePage({ api, session, disabled, onStart, onNavigate }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState(null), [selected, setSelected] = useState('');
  const [year, setYear] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(false), revision = useRef(0), searchInput = useRef(null);
  useEffect(() => { active.current = true; searchInput.current?.focus(); return () => { active.current = false; revision.current++; }; }, []);
  async function search(event) {
    event.preventDefault(); if (busy || disabled || !query.trim()) return;
    const ticket = ++revision.current; setBusy(true); setError(''); setResult(null); setSelected(''); setConsent(false);
    try { const value = await api.request('/api/gmail/notices/search', { query: query.trim() }); if (active.current && revision.current === ticket) setResult(value); }
    catch (problem) { if (active.current && revision.current === ticket) setError(problem.message); }
    finally { if (active.current && revision.current === ticket) setBusy(false); }
  }
  if (!session.inference?.localOnly) return <section className="settings-page notice-page"><h2>School notice</h2><p>This briefing needs local Gemma on your host computer. It won’t use ChatGPT.</p><button className="app-button" onClick={() => onNavigate('settings')}>Open settings</button></section>;
  return <section className="settings-page notice-page" aria-labelledby="school-notice-heading">
    <header className="settings-intro"><p className="notice-eyebrow">One useful thing, checked locally</p><h2 id="school-notice-heading">Make sense of a school notice.</h2><p>Choose one email. Nemo will pull out what to do, put explicit dates first, and show the words it used.</p></header>
    <form className="notice-search" onSubmit={search}><label htmlFor="notice-query">Find the notice in your Gmail</label><div className="notice-search-row"><input id="notice-query" ref={searchInput} type="search" value={query} maxLength={500} placeholder="A sender, subject, or school name" required disabled={busy || disabled} onChange={event => setQuery(event.target.value)} /><button type="submit" className="app-button" disabled={busy || disabled || !query.trim()}>{busy ? 'Searching…' : 'Find notices'}</button></div><p className="quiet">Only five matching previews are shown. Refine your search if the right notice is missing.</p></form>
    {disabled && <p role="status" className="notice-status">Wait for the current reply or resolve the last send before starting another task.</p>}
    {error && <p role="alert" className="notice-status">{error}</p>}
    {busy && <p role="status" className="notice-status">Searching your connected account…</p>}
    {result && !result.messages?.length && <p role="status" className="notice-status">No matching notice was returned. Try its sender or a few words from the subject.</p>}
    {result?.messages?.length > 0 && <>
      <fieldset className="notice-results"><legend>Which message should Nemo read?</legend>{result.messages.map(message => <label className={`notice-option ${selected === message.selection ? 'selected' : ''}`} key={message.selection}><input type="radio" name="notice-selection" value={message.selection} checked={selected === message.selection} disabled={disabled} onChange={() => { setSelected(message.selection); setConsent(false); }} /><span><strong>{message.subject || '(No subject)'}</strong><span className="notice-meta">{message.from} · {message.date}</span><span className="notice-snippet">{message.snippet}</span></span></label>)}</fieldset>
      {result.hasMore && <p className="quiet">More messages match. Narrow the search to find another notice.</p>}
      <div className="notice-confirm"><label htmlFor="notice-year">School year <span className="quiet">(if the notice covers several groups)</span></label><select id="notice-year" value={year} disabled={disabled} onChange={event => setYear(event.target.value)}><option value="">Not specified</option>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>Year {i + 1}</option>)}</select>
        <label className="notice-consent"><input type="checkbox" checked={consent} disabled={!selected || disabled} onChange={event => setConsent(event.target.checked)} /><span>Read the selected message’s text and process it locally for this briefing. Save the result and supporting quotes in this chat.</span></label>
        <p className="quiet">Attachments and linked pages won’t be opened. The notice won’t be saved to Memory. This permission applies to this task and does not turn on general Connections in chat.</p>
        <button type="button" className="app-button" disabled={!selected || !consent || disabled || busy} onClick={() => void onStart({ name: 'school_briefing.v1', selection: selected, bodyConsent: true, year: year ? Number(year) : null })}>Brief selected notice</button>
      </div>
    </>}
  </section>;
}

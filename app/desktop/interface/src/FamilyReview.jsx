import React, { useEffect, useRef, useState } from 'react';
import { createFamilyReviewReader } from '../../../public/desktop-family-review.mjs';

export function FamilyReview({ api, owner, child, onClose, onError }) {
  const context = useRef({ owner, child }), reader = useRef(null), mounted = useRef(false), revision = useRef(0);
  const [data, setData] = useState(null), [view, setView] = useState({ kind: 'history', conversation: null }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  context.current = { owner, child };
  if (!reader.current) reader.current = createFamilyReviewReader({ request: path => api.request(path), getContext: () => context.current });
  async function load(kind, conversation = null) {
    const ticket = ++revision.current;
    setData(null); setView({ kind, conversation }); setBusy(true); setError('');
    try {
      const result = await reader.current.read(kind, conversation);
      if (mounted.current && ticket === revision.current) setData(result);
    } catch (problem) {
      if (!mounted.current || ticket !== revision.current) return;
      setError(problem.message || 'This review could not be opened.');
      if (problem.status === 401 || problem.code === 'PROFILE_CHANGED') onError?.(problem);
    } finally { if (mounted.current && ticket === revision.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void load('history');
    return () => { mounted.current = false; revision.current++; reader.current.invalidate(); };
  }, [owner.id, child.id, child.policyRevision, child.parentalReview, child.classification, child.disabled]);
  return <section className="family-review-panel" aria-label={`Family review for ${child.name}`}>
    <div className="family-section-heading"><h3>{child.name}’s {view.kind === 'memory' ? 'Memory' : 'history'}</h3><button className="family-text-button" onClick={onClose}>Close review</button></div>
    <p className="family-review-explanation">Read only · Each review is recorded and visible to {child.name}. Their information stays separate from your own conversations and Memory.</p>
    <div className="family-review-tabs" role="group" aria-label="Review content"><button className="family-button" aria-pressed={view.kind === 'history'} onClick={() => void load('history')}>Chat history</button><button className="family-button" aria-pressed={view.kind === 'memory'} onClick={() => void load('memory')}>Personal Memory</button></div>
    {busy && <p className="quiet" role="status">Opening the review…</p>}
    {error && <p className="family-message family-error" role="alert">{error}</p>}
    {data && (view.kind === 'memory' ? <div className="family-review-content"><h4>Memory summary</h4><p>{data.summary?.segments?.map(segment => segment.text).join(' ') || 'No personal memories saved.'}</p>{(data.items || []).map((fact, index) => <article key={fact.id || index}><h4>{fact.title || 'Memory'}</h4><p>{fact.text || fact.summary || ''}</p></article>)}</div> : view.conversation ? <div className="family-review-content"><button className="family-text-button" onClick={() => void load('history')}>← All conversations</button><h4>{view.conversation.title || 'Conversation'}</h4>{(data.messages || []).map((message, index) => <article key={message.id || index}><strong>{message.role === 'user' ? child.name : 'Nemo'}</strong><p>{message.text}</p></article>)}{!data.messages?.length && <p className="quiet">No messages saved in this conversation.</p>}</div> : <div className="family-review-list">{data.conversations?.length ? data.conversations.map(conversation => <article key={`${conversation.source}-${conversation.id}`}><div><h4>{conversation.title || 'Conversation'}</h4><p>{conversation.source === 'native' ? 'Native preview conversation' : 'Main chat'}</p></div><button className="family-text-button" onClick={() => void load('history', conversation)}>View conversation</button></article>) : <p className="quiet">No saved conversations.</p>}</div>)}
  </section>;
}

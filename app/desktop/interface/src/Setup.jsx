import React, { useEffect, useRef, useState } from 'react';
import { SidebarLayout } from './Layout.jsx';
import { useSetup } from './useSetup.jsx';
import { setupState, canOpenPersonalSpace } from '../../../public/desktop-setup.mjs';
import { PhoneAccess } from './PhoneAccess.jsx';
import './setup-ui.css';

export function SetupFlow({ profileId, embedded = false, onReady }) {
  const { status, busy, error, act, refresh } = useSetup(profileId);
  const [name, setName] = useState(''), [showPhone, setShowPhone] = useState(false), [login, setLogin] = useState(false);
  const state = setupState(status), assistant = status?.assistant || status?.runtime?.assistant;
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, [state]);
  useEffect(() => { if (window.nemoDesktop && status) window.nemoDesktop.getStartAtLogin(profileId).then(setLogin).catch(() => {}); }, [profileId, !!status]);
  const ready = state === 'ready';
  const local = assistant?.provider === 'ollama';
  const cloudReady = ready && !local;
  const confirmation = ready && (assistant?.confirmationRequired === true || assistant?.planUsageAcknowledged === false);
  const pending = ['waiting', 'connecting'].includes(assistant?.phase);
  const recovering = assistant?.connected === true && assistant?.phase === 'error';
  const accounts = assistant?.accounts || [];
  async function continueHere(request) {
    if (window.nemoDesktop) { await request('openLocal'); return; }
    const invitation = await request('localInvite'), target = new URL(invitation.url), expected = new URL(status.app.origin);
    if (target.origin !== expected.origin || target.pathname !== '/pair.html' || target.search || target.username || target.password || !/^#invite=[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(target.hash) || invitation.profile?.id !== status.owner.id) throw new Error('Nemo could not confirm your profile. Try again.');
    target.pathname = '/desktop.html'; window.location.assign(target.href);
  }
  const content = <div className={embedded ? 'host-settings' : 'onboarding-content'}>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => void act('refresh', refresh)}>Try again</button></div>}
    {state === 'loading' ? <div className="setup-loading" role="status">Opening Nemo’s settings…</div> : <>
      {!embedded && <div className="setup-intro"><span className="setup-symbol" aria-hidden="true">✳</span><h2 ref={heading} tabIndex="-1">{state === 'name' ? 'Welcome to Nemo' : state === 'runtime' ? 'Getting your assistant ready' : state === 'assistant' ? 'Choose your assistant' : `You’re ready, ${status.owner.name}`}</h2><p>{state === 'name' ? 'Your own assistant. One place for the family.' : state === 'runtime' ? 'Prepare the Hermes assistant included with Nemo.' : state === 'assistant' ? 'Run Gemma on this PC, or choose your ChatGPT plan.' : 'Your conversations stay in your own profile.'}</p></div>}
      {state === 'name' ? <form className="setup-form" onSubmit={event => { event.preventDefault(); void act('prepare', async request => { await request('owner', { name: name.trim() }); await refresh(); if (!status.runtime?.ready) await request('runtime'); }); }}><label htmlFor="setup-name">Your first name</label><input id="setup-name" autoComplete="given-name" autoFocus maxLength="60" required value={name} onChange={event => setName(event.target.value)} placeholder="First name" disabled={!!busy} /><p className="field-help">You’ll manage this home. Add the rest of your family after setup.</p><button className="primary-button" disabled={!!busy || !name.trim()}>{busy ? 'Preparing Nemo…' : 'Continue'}</button></form> : <>
        {(state === 'runtime' || embedded) && <div className="connection-row"><div><h3>Assistant on this PC</h3><p>{status.runtime?.ready ? 'Ready · Included with Nemo' : busy === 'prepare' ? 'Preparing your assistant. Leave Nemo open for a moment.' : status.runtime?.message || 'Prepare the bundled assistant to get started.'}</p></div>{!status.runtime?.ready && <button className="app-button" disabled={!!busy || status.runtime?.available === false} onClick={() => void act('prepare', request => request('runtime'))}>{busy === 'prepare' ? 'Preparing…' : 'Prepare Nemo'}</button>}{status.runtime?.ready && <span className="status-badge">Ready</span>}</div>}
        {(status.runtime?.ready || embedded) && <section className="provider-settings" aria-label="Assistant provider">
          <div className="connection-row"><div><h3>Local Gemma 4 12B</h3><p>{local ? assistant.message : 'Run on this PC with Ollama. No ChatGPT sign-in needed.'}</p><small>Local replies · No automatic cloud fallback</small></div>{local && ready ? <span className="status-badge">Selected</span> : <button className="app-button" disabled={!!busy || !status.runtime?.ready} onClick={() => void act('local', request => request('assistant', { provider: 'local' }))}>{busy === 'local' ? 'Checking Ollama…' : local ? 'Check Ollama again' : 'Use local Gemma'}</button>}</div>
          <div className="connection-row"><div><h3>ChatGPT</h3><p>{local ? 'Optional cloud assistant using your ChatGPT plan.' : cloudReady ? assistant?.account?.label || assistant?.account?.email || 'Connected to this home' : recovering ? 'Your account is saved. Finish reconnecting the assistant.' : assistant?.message || 'Sign in securely on OpenAI’s own page.'}</p>{embedded && !local && <small>Shared AI connection · Each person’s conversations and accounts stay separate.</small>}</div>{cloudReady ? <span className="status-badge">Connected</span> : <button className="app-button" disabled={!!busy || pending || !status.runtime?.ready} onClick={() => void act('connect', request => request('assistant', recovering ? { retry: true } : { provider: 'chatgpt' }))}>{busy === 'connect' || pending ? 'Waiting for sign-in…' : recovering ? 'Finish connecting' : local ? 'Use ChatGPT instead' : 'Continue with ChatGPT'}</button>}</div>
          {pending && <div className="sign-in-wait" role="status"><span className="activity-dot" />Finish signing in in your browser, then return to Nemo.<button disabled={!!busy} onClick={() => void act('connect', request => request('assistant'))}>Open sign-in again ↗</button></div>}
          {confirmation && <div className="plan-notice" role="region" aria-label="ChatGPT plan usage"><strong>You’re using your ChatGPT plan</strong><p>Replies use your plan allowance or available credits. Your ChatGPT usage and credit settings apply.</p><div className="inline-actions"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a><button className="app-button" disabled={!!busy} onClick={() => void act('acknowledge', request => request('assistant', { action: 'acknowledge' }))}>Got it</button></div></div>}
          {!local && (embedded || ready) && <details className="connection-details"><summary>ChatGPT account settings</summary>{accounts.length > 1 && <label>Use a saved account<select aria-label="Saved ChatGPT account" value={assistant.activeAccountId || ''} disabled={!!busy} onChange={event => { const accountId = event.target.value; void act('account', request => request('assistant', { action: 'select', accountId })); }}><option value="" disabled>Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>}<div className="inline-actions"><button className="app-button" disabled={!!busy} onClick={() => void act('account', request => request('assistant', { action: 'new' }))}>Use another account</button>{assistant?.account && <button className="text-button" disabled={!!busy} onClick={() => { if (window.confirm('Disconnect ChatGPT from this home? New replies will stop. Saved chats stay on this PC.')) void act('disconnect', request => request('assistant', { action: 'signout' })); }}>Disconnect</button>}</div></details>}
        </section>}
        {canOpenPersonalSpace(status) && !embedded && <div className="setup-complete"><button className="primary-button" disabled={!!busy || confirmation} onClick={() => void act('open', continueHere)}>{busy === 'open' ? 'Opening your space…' : `Continue as ${status.owner.name}`}</button><p className="field-help">Your saved chats and connected accounts stay with your profile.</p></div>}
        {embedded && <>
          <div className="connection-row"><div><h3>Open Nemo at sign-in</h3><p>Keep your home assistant available when this PC starts.</p></div><label className="toggle-label"><input type="checkbox" aria-label="Open Nemo at sign-in" checked={login} disabled={!!busy || !window.nemoDesktop} onChange={event => { const enabled = event.target.checked; void act('login', async () => setLogin(await window.nemoDesktop.setStartAtLogin(enabled, profileId))); }} /><span>{login ? 'On' : 'Off'}</span></label></div>
          <div className="connection-row"><div><h3>Phone access</h3><p>{status.remote?.canPair ? 'On · Invite a device to its personal profile.' : 'Optional · Use Nemo away from this PC.'}</p></div><button className="app-button" onClick={() => setShowPhone(!showPhone)}>{showPhone ? 'Hide' : 'Manage'}</button></div>
          {showPhone && <PhoneAccess status={status} busy={busy} act={act} />}
          {onReady && <button className="text-button" onClick={onReady}>Back to your settings</button>}
        </>}
      </>}
      {!embedded && <p className="setup-footnote">{local ? 'Replies are processed on this PC. Connected services use their own network connections.' : 'Saved on this PC. Relevant context is sent to ChatGPT when you choose it for replies.'}</p>}
    </>}
  </div>;
  if (embedded) return content;
  const steps = [{ id: 'name', name: 'Your profile', detail: 'Make Nemo yours' }, { id: 'runtime', name: 'Your assistant', detail: 'Included with the app' }, { id: 'assistant', name: 'Reply provider', detail: 'Local Gemma or ChatGPT' }, { id: 'ready', name: 'Ready to chat', detail: 'Add family whenever you like' }];
  const index = steps.findIndex(step => step.id === state);
  return <SidebarLayout title="Set up Nemo" sidebar={<ol className="setup-steps">{steps.map((step, i) => <li key={step.id} className={state === step.id ? 'current' : i < index ? 'complete' : ''} aria-current={state === step.id ? 'step' : undefined}><span className="step-number" aria-hidden="true">{i < index ? '✓' : i + 1}</span><div><strong>{step.name}</strong><small>{step.detail}</small></div></li>)}</ol>} sidebarFooter={<p className="quiet">One home. A personal Nemo for everyone.</p>}>{content}</SidebarLayout>;
}

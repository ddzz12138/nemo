/* Nemo's client keeps credentials in same-origin cookies, never in URLs or storage. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'connectionButton', 'connectionLabel', 'connectionDot', 'conversation', 'welcome',
    'messages', 'runStatus', 'runStatusText', 'conversationEnd', 'latestButton',
    'notice', 'noticeText', 'noticeAction', 'chatForm', 'messageInput', 'sendButton',
    'composerContext', 'composerCaption', 'chatgptPlan', 'chatgptPlanLabel', 'connectionDialog', 'dialogTitle',
    'dialogDescription', 'closeDialog', 'pairForm', 'pairCode', 'pairButton',
    'pairedDetails', 'dialogConnectionStatus', 'modelRow', 'modelValue',
    'serverAddress', 'refreshConnection', 'logoutButton', 'dialogMessage', 'announcer', 'deviceName'
  ].map((id) => [id, $(id)]));

  const STORE_DRAFT = 'nemo.draft.v2';
  const STORE_PENDING = 'nemo.pending.v2';
  const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
  let integrations = null;
  const state = {
    authenticated: false,
    profile: null,
    connected: false,
    reachable: null,
    restoring: true,
    submitting: false,
    messages: [],
    conversationId: null,
    run: null,
    pending: null,
    model: '',
    planUsage: null,
    activityTimer: null,
    activityVersion: 0,
    pollTimer: null,
    pollVersion: 0,
    refreshing: null,
    noticeAction: null,
    dialogOpener: null,
    messageElements: new Map(),
    runAnnouncement: '',
    followLatest: true
  };

  if (!state.pending || typeof state.pending.message !== 'string' || typeof state.pending.requestId !== 'string') {
    state.pending = null;
    saveStored(STORE_PENDING, null);
  }

  function readStored(key) {
    if (!state.profile) return null;
    try { return JSON.parse(sessionStorage.getItem(`${key}.${state.profile.id}`) || 'null'); }
    catch { return null; }
  }

  function saveStored(key, value) {
    if (!state.profile) return;
    key = `${key}.${state.profile.id}`;
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch { /* The app also works when private storage is unavailable. */ }
  }

  class ApiError extends Error {
    constructor(message, status = 0, code = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    // First contact can include discovery, a relay grant and ICE negotiation.
    // Give that verified connection time to finish before timing out the API.
    const timeout = setTimeout(() => controller.abort(), window.NemoPhoneLink?.enabled ? 60000 : 15000);
    try {
      const response = await window.nemoFetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(state.profile && !['/api/session', '/api/pair'].includes(path) ? { 'X-Nemo-Profile': state.profile.id } : {}),
          ...(options.method && options.method !== 'GET' ? {
            'Content-Type': 'application/json',
            'X-Nemo-Request': '1'
          } : {}),
          ...options.headers
        },
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json() : null;
      if (!response.ok) {
        throw new ApiError(data?.error || 'The server could not complete this request.', response.status, data?.code || '');
      }
      if (!data) throw new ApiError('The server returned an unexpected response.', response.status);
      state.reachable = true;
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'AbortError') throw new ApiError('The connection took too long. Your PC may still be working.', 0, 'TIMEOUT');
      throw new ApiError(navigator.onLine === false ? 'This device is offline. Reconnect to continue.' : 'Your PC could not be reached. Check your connection and try again.', 0, 'NETWORK');
    } finally {
      clearTimeout(timeout);
    }
  }

  function announce(text) {
    ui.announcer.textContent = text;
  }

  function notice(text, label = '', action = null, kind = '') {
    ui.notice.hidden = !text;
    ui.noticeText.textContent = text;
    ui.notice.dataset.kind = kind;
    ui.noticeAction.hidden = !label;
    ui.noticeAction.textContent = label;
    state.noticeAction = action;
  }

  function chatgptFailure(value) {
    const code = value?.errorCode || value?.code;
    if (code === 'CHATGPT_USAGE_LIMIT') {
      notice('Your ChatGPT usage limit was reached. Review your plan or Nemo’s limit in ChatGPT settings.', 'Manage usage', () => window.open(CHATGPT_USAGE_URL, '_blank', 'noopener,noreferrer'), 'error');
      return true;
    }
    const messages = {
      CHATGPT_SIGN_IN_REQUIRED: 'Open Nemo on your computer and reconnect your ChatGPT account. Your chats are saved.',
      CHATGPT_NOT_ELIGIBLE: 'ChatGPT plan usage is unavailable for this account. Open Nemo on your computer to choose an eligible account.',
      CHATGPT_UNAVAILABLE: 'ChatGPT is temporarily unavailable. Your chats are saved. Try again shortly.',
    };
    if (!Object.hasOwn(messages, code)) return false;
    notice(messages[code], 'Check again', () => refresh(false), 'error');
    return true;
  }

  function dialogMessage(text) {
    ui.dialogMessage.textContent = text;
    ui.dialogMessage.hidden = !text;
  }

  function openDialog() {
    const active = document.activeElement;
    state.dialogOpener = active?.closest?.('dialog:not([open])') ? document.querySelector('.nemo-profile-button') : active;
    dialogMessage('');
    if (!ui.connectionDialog.open) ui.connectionDialog.showModal();
    ui.dialogTitle.focus({ preventScroll: true });
  }

  function updateControls() {
    integrations?.setAuthenticated(state.authenticated);
    let label = 'Connecting';
    let dot = 'checking';
    if (navigator.onLine === false) {
      label = 'Offline'; dot = 'offline';
    } else if (state.reachable === false) {
      label = 'PC unreachable'; dot = 'offline';
    } else if (state.reachable) {
      if (!state.authenticated) label = 'Connect your PC';
      else if (state.connected) { label = 'PC connected'; dot = 'connected'; }
      else { label = state.planUsage?.provider === 'chatgpt' ? 'Connect ChatGPT' : 'Agent offline'; dot = 'offline'; }
    }
    ui.connectionLabel.textContent = label;
    ui.connectionDot.dataset.state = dot;
    ui.connectionButton.setAttribute('aria-label', `${label}. Open connection settings`);
    ui.dialogConnectionStatus.textContent = state.reachable === false ? 'PC unreachable' : state.connected ? 'Connected' : state.planUsage?.provider === 'chatgpt' ? 'ChatGPT connection needed' : 'Agent offline';
    ui.pairForm.hidden = state.authenticated;
    ui.pairedDetails.hidden = !state.authenticated;
    ui.dialogTitle.textContent = state.authenticated ? 'Your agent, connected.' : 'Connect to your agent.';
    ui.dialogDescription.textContent = state.authenticated
      ? 'A personal window to Hermes, running on your PC.'
      : 'Enter your personal invitation code to connect this device to your profile.';
    ui.modelRow.hidden = !state.model;
    ui.modelValue.textContent = state.model;
    ui.serverAddress.textContent = window.NemoPhoneLink?.enabled
      ? `Phone interface: ${location.origin}. Messages use an encrypted connection to your computer.`
      : location.origin;
    ui.composerContext.textContent = state.authenticated ? 'Hermes · your PC' : 'Your personal agent';
    ui.chatgptPlan.hidden = !state.authenticated || state.planUsage?.provider !== 'chatgpt';
    ui.chatgptPlanLabel.textContent = state.planUsage?.enabled === true ? 'Using ChatGPT plan' : 'ChatGPT plan connection needed';
    document.body.dataset.chatReady = String(state.authenticated && state.connected && state.reachable && !state.restoring);
    ui.messageInput.disabled = !state.authenticated || state.restoring;
    ui.sendButton.disabled = !state.authenticated || !state.connected || !state.reachable || navigator.onLine === false
      || state.restoring || state.submitting || Boolean(state.run) || Boolean(state.pending) || integrations?.isSaving() || !ui.messageInput.value.trim();
    ui.sendButton.querySelector('span').textContent = state.submitting ? 'Sending' : 'Send';
    if (state.restoring) ui.composerCaption.textContent = 'Connecting to your PC…';
    else if (!state.authenticated) ui.composerCaption.textContent = 'Connect your PC to start a conversation.';
    else if (!state.reachable) ui.composerCaption.textContent = 'Your conversation will be here when you reconnect.';
    else if (!state.connected) ui.composerCaption.textContent = state.planUsage?.provider === 'chatgpt' ? 'Open Nemo on your computer to reconnect ChatGPT.' : 'Start Hermes on your PC to continue.';
    else if (state.run) ui.composerCaption.textContent = 'Your PC is working. You can write your next thought.';
    else ui.composerCaption.textContent = 'Responses come from Hermes on your PC.';
  }

  function isNearBottom() {
    return ui.conversation.scrollHeight - ui.conversation.scrollTop - ui.conversation.clientHeight < 96;
  }

  function scrollToLatest(force = false) {
    if (state.followLatest || force) {
      ui.conversation.scrollTop = ui.conversation.scrollHeight;
      state.followLatest = true;
      ui.latestButton.hidden = true;
    } else {
      ui.latestButton.hidden = false;
    }
  }

  // Only small, explicit text formatting is supported. Provider text never
  // becomes HTML, a link, an image or an executable attribute.
  function renderMessageContent(container, value, formatted) {
    const text = String(value || '');
    container.replaceChildren();
    if (!formatted || text.length > 64000) { container.textContent = text; return; }
    const inline = (parent, line) => {
      for (const part of line.split(/(\*\*[^*\n]+\*\*)/g)) {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); parent.append(strong);
        } else parent.append(document.createTextNode(part));
      }
    };
    let list = null, paragraph = null;
    for (const line of text.split('\n')) {
      const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
      if (bullet) {
        paragraph = null;
        if (!list) { list = document.createElement('ul'); container.append(list); }
        const item = document.createElement('li'); inline(item, bullet[1]); list.append(item);
      } else {
        list = null;
        if (!line.trim()) { paragraph = null; continue; }
        if (!paragraph) { paragraph = document.createElement('p'); container.append(paragraph); }
        else paragraph.append(document.createElement('br'));
        inline(paragraph, line);
      }
    }
  }

  function renderMessages(forceScroll = false) {
    const displayed = [...state.messages];
    if (state.pending && !(state.run && state.messages.some((message) => message.role === 'user' && message.text === state.pending.message))) {
      displayed.push({ id: `pending-${state.pending.requestId}`, role: 'user', text: state.pending.message, pending: true });
    }
    if (state.run && (state.run.text || state.run.activity)) displayed.push({ id: `run-${state.run.id}`, role: 'assistant', text: state.run.text || '', activity: state.run.activity });
    ui.welcome.hidden = displayed.length > 0 || Boolean(state.run);
    ui.messages.hidden = displayed.length === 0;
    const keepIds = new Set(displayed.map((message) => message.id));
    for (const [id, element] of state.messageElements) {
      if (!keepIds.has(id)) {
        element.remove();
        state.messageElements.delete(id);
      }
    }
    for (const [index, message] of displayed.entries()) {
      let element = state.messageElements.get(message.id);
      if (!element) {
        element = document.createElement('article');
        element.className = 'message';
        element.dataset.role = message.role;
        element.setAttribute('aria-label', message.role === 'user' ? 'Your message' : 'Nemo response');
        if (message.role === 'assistant') {
          const label = document.createElement('span');
          label.className = 'message-label';
          label.textContent = 'Nemo';
          element.appendChild(label);
        }
        const content = document.createElement('div');
        content.className = 'message-content';
        element.appendChild(content);
        state.messageElements.set(message.id, element);
      }
      element.dataset.pending = String(Boolean(message.pending));
      const content = element.querySelector('.message-content');
      if (content.nemoText !== message.text) {
        renderMessageContent(content, message.text, message.role === 'assistant');
        content.nemoText = message.text;
      }
      window.NemoActivity?.render(element,message.activity);
      // Preserve existing nodes and scroll positions when only response text changes.
      if (ui.messages.children[index] !== element) ui.messages.insertBefore(element, ui.messages.children[index] || null);
    }
    ui.runStatus.hidden = Boolean(state.run?.activity) || (!state.run && !state.submitting);
    const runLabel = state.submitting ? 'Sending to your PC…'
      : state.run?.status === 'queued' ? 'Queued on your PC'
      : state.run?.status === 'completed' ? 'Reply ready · restoring conversation'
      : state.run?.status === 'failed' ? 'Task failed · restoring conversation'
      : state.run ? 'Hermes is working on your PC' : '';
    if (runLabel !== state.runAnnouncement) {
      ui.runStatusText.textContent = runLabel;
      state.runAnnouncement = runLabel;
    }
    requestAnimationFrame(() => scrollToLatest(forceScroll));
    updateControls();
  }

  function resizeInput() {
    ui.messageInput.style.height = 'auto';
    ui.messageInput.style.height = `${Math.min(ui.messageInput.scrollHeight, 160)}px`;
  }

  function clearPending() {
    state.pending = null;
    saveStored(STORE_PENDING, null);
  }

  function stopPolling() {
    state.pollVersion += 1;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function requirePairing() {
    stopActivityPolling();
    stopPolling();
    state.authenticated = false;
    state.connected = false;
    state.planUsage = null;
    state.messages = [];
    state.run = null;
    state.conversationId = null;
    state.restoring = false;
    notice('Pair this device with your PC to continue.', 'Connect', openDialog);
    renderMessages();
    openDialog();
  }

  async function loadConversation() {
    const conversation = await api('/api/conversation');
    state.conversationId = conversation.conversationId;
    state.messages = Array.isArray(conversation.messages)
      ? conversation.messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.text === 'string').map((message) => ({ ...message, id: String(message.id) }))
      : [];
    if(!conversation.activeRunId && state.run && state.messages.some(message=>message.activity?.runId===state.run.id)) {
      state.run=null;
      if(!state.pending)notice('');
    }
    if (conversation.activeRunId) {
      if (!state.run || state.run.id !== conversation.activeRunId) {
        state.run = { id: conversation.activeRunId, status: 'running', text: '' };
        startPolling(conversation.activeRunId);
      }
    }
    renderMessages();
    scheduleActivityPolling();
    return conversation;
  }

  function stopActivityPolling() {
    state.activityVersion++;
    clearTimeout(state.activityTimer); state.activityTimer=null;
  }
  function scheduleActivityPolling(delay=1000) {
    clearTimeout(state.activityTimer); state.activityTimer=null;
    if(!state.authenticated || !state.messages.some(message=>message.activity?.pending))return;
    const version=state.activityVersion;
    state.activityTimer=setTimeout(async()=>{
      if(version!==state.activityVersion || !state.authenticated)return;
      try {
        await loadConversation();
      } catch(error) {
        if(version!==state.activityVersion)return;
        if(error.status===401){requirePairing();return;}
        if(error.status===409){stopActivityPolling();void refresh(false);return;}
        scheduleActivityPolling(3000);
      }
    },delay);
  }

  function startPolling(runId) {
    stopPolling();
    const version = state.pollVersion;
    async function poll() {
      if (version !== state.pollVersion || !state.authenticated) return;
      let delay = 1000;
      try {
        const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
        if (version !== state.pollVersion) return;
        state.run = { ...run, text: typeof run.text === 'string' ? run.text : '' };
        if (run.status === 'completed' || run.status === 'failed') {
          // Keep the last known output visible until canonical history loads.
          const terminalRun = state.run;
          try {
            await loadConversation();
            if (version !== state.pollVersion) return;
            state.run = null;
            renderMessages();
            if (run.status === 'failed') {
              if (!chatgptFailure(run)) notice(run.error || 'Hermes could not finish this request. Check the agent on your PC and try a new message.', 'Check connection', () => refresh(false), 'error');
              announce('Hermes could not finish the request.');
            } else {
              if (state.pending) notice('Your last send still needs confirmation before sending another message.', 'Check message', () => submitPending());
              else notice('');
              announce('Hermes has replied.');
            }
            stopPolling();
            return;
          } catch (error) {
            state.run = terminalRun;
            throw error;
          }
        }
        notice('');
        renderMessages();
      } catch (error) {
        if (version !== state.pollVersion) return;
        if (error.status === 401) { requirePairing(); return; }
        if (error.status === 404) {
          stopPolling();
          state.run = null;
          notice('This task is no longer available on your PC. Check the conversation before sending again.', 'Check connection', () => refresh(false), 'error');
          renderMessages();
          return;
        }
        if (!error.status) state.reachable = false;
        notice(state.run?.status === 'completed'
          ? 'Your reply is ready. Reconnecting to restore the conversation…'
          : 'Connection interrupted. Your PC may still be working. Reconnecting…', '', null, 'error');
        updateControls();
        delay = 3000;
      }
      if (version === state.pollVersion) state.pollTimer = setTimeout(poll, delay);
    }
    void poll();
  }

  async function refresh(showPairing = false) {
    if (state.refreshing) return state.refreshing;
    state.refreshing = (async () => {
      try {
        const session = await api('/api/session');
        if (state.profile?.id !== session.profile?.id) {
          stopActivityPolling(); stopPolling(); state.messages = []; state.run = null; state.pending = null; ui.messageInput.value = '';
          state.profile = session.profile || null;
          if (state.profile) {
            const pending = readStored(STORE_PENDING);
            if (pending?.profileId === state.profile.id && typeof pending.message === 'string' && typeof pending.requestId === 'string') state.pending = pending;
            const draft = readStored(STORE_DRAFT); if (typeof draft === 'string') ui.messageInput.value = draft;
            resizeInput();
          }
        } else state.profile = session.profile || null;
        state.authenticated = Boolean(session.authenticated);
        state.connected = Boolean(session.connected);
        state.model = typeof session.model === 'string' ? session.model : '';
        state.planUsage = session.authenticated && session.planUsage?.provider === 'chatgpt' ? { provider:'chatgpt', enabled:session.planUsage.enabled === true } : null;
        if (!state.authenticated) {
          stopPolling();
          state.messages = [];
          state.run = null;
          notice('');
          if (showPairing) openDialog();
        } else {
          await loadConversation();
          if (state.pending && !state.run) {
            notice('Your last send is unconfirmed. Check it before sending another message.', 'Check message', () => submitPending(), 'error');
          } else if (!state.connected) {
            notice(state.planUsage?.provider === 'chatgpt' ? 'Open Nemo on your computer and connect your ChatGPT account. Your chats are saved.' : 'Hermes is not ready. Start the agent on your PC, then check again.', 'Check again', () => refresh(false));
          } else if (!state.run) notice('');
        }
        dialogMessage('');
      } catch (error) {
        if (error.status === 401) {
          requirePairing();
        } else {
          if (!error.status) state.reachable = false;
          notice(error.message, 'Try again', () => refresh(true), 'error');
          if (ui.connectionDialog.open) dialogMessage(error.message);
        }
      } finally {
        state.restoring = false;
        state.refreshing = null;
        renderMessages();
      }
    })();
    return state.refreshing;
  }

  async function submitPending() {
    if (!state.pending || state.submitting || !state.authenticated) return;
    if (state.pending.profileId !== state.profile?.id) { clearPending(); return; }
    const pending = state.pending;
    state.submitting = true;
    state.followLatest = true;
    notice('');
    renderMessages(true);
    try {
      const accepted = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: pending.message,
          requestId: pending.requestId
        })
      });
      state.conversationId = accepted.conversationId;
      clearPending();
      state.run = { id: accepted.runId, status: 'queued', text: '' };
      // Retain the sent message if history is temporarily unavailable.
      const localMessage = { id: `accepted-${pending.requestId}`, role: 'user', text: pending.message };
      state.messages.push(localMessage);
      try { await loadConversation(); }
      catch (error) {
        if (error.status === 401) { requirePairing(); return; }
      }
      // A fast reply or failure can already be in saved history. Still fetch
      // its terminal outcome so account/usage-limit recovery is not lost.
      if (!state.run || state.run.id === accepted.runId) {
        state.run ||= { id: accepted.runId, status: 'queued', text: '' };
        startPolling(accepted.runId);
      }
      announce('Message received by your PC.');
    } catch (error) {
      if (error.status === 401) {
        requirePairing();
      } else if (error.status >= 400 && error.status < 500 && error.status !== 408) {
        // A definite rejection is safe to put back in the composer.
        clearPending();
        if (!ui.messageInput.value.trim()) ui.messageInput.value = pending.message;
        saveStored(STORE_DRAFT, ui.messageInput.value);
        resizeInput();
        if (!chatgptFailure(error)) notice(error.message, 'Check connection', () => refresh(false), 'error');
      } else {
        if (!error.status) state.reachable = false;
        notice('We could not confirm delivery. Your message is saved here. Check it before sending again.', 'Check message', () => submitPending(), 'error');
      }
    } finally {
      state.submitting = false;
      renderMessages(true);
    }
  }

  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  ui.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = ui.messageInput.value.trim();
    if (ui.sendButton.disabled || !message) return;
    state.pending = {
      requestId: requestId(),
      message,
      profileId: state.profile.id,
      createdAt: new Date().toISOString()
    };
    saveStored(STORE_PENDING, state.pending);
    ui.messageInput.value = '';
    saveStored(STORE_DRAFT, null);
    resizeInput();
    void submitPending();
  });

  ui.messageInput.addEventListener('input', () => {
    resizeInput();
    saveStored(STORE_DRAFT, ui.messageInput.value || null);
    updateControls();
  });
  ui.messageInput.addEventListener('keydown', (event) => {
    // Preserve Return for multiline writing on touch devices; desktop Enter sends.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(hover: hover) and (pointer: fine)').matches) {
      event.preventDefault();
      if (!ui.sendButton.disabled) ui.chatForm.requestSubmit();
    }
  });

  ui.connectionButton.addEventListener('click', openDialog);
  ui.closeDialog.addEventListener('click', () => ui.connectionDialog.close());
  ui.connectionDialog.addEventListener('close', () => {
    const opener = state.dialogOpener;
    if (opener instanceof HTMLElement && opener !== document.body) opener.focus({ preventScroll: true });
  });
  ui.connectionDialog.addEventListener('click', (event) => {
    if (event.target !== ui.connectionDialog) return;
    const rect = ui.connectionDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) ui.connectionDialog.close();
  });
  ui.noticeAction.addEventListener('click', () => {
    if (state.noticeAction) void state.noticeAction();
  });
  ui.latestButton.addEventListener('click', () => scrollToLatest(true));
  ui.conversation.addEventListener('scroll', () => {
    state.followLatest = isNearBottom();
    if (state.followLatest) ui.latestButton.hidden = true;
  }, { passive: true });

  ui.pairForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = ui.pairCode.value.trim();
    if (!code || ui.pairButton.disabled) return;
    ui.pairButton.disabled = true;
    ui.pairButton.textContent = 'Connecting…';
    dialogMessage('');
    try {
      await api('/api/pair', { method: 'POST', body: JSON.stringify({ code, deviceName: ui.deviceName.value.trim() || 'Personal browser' }) });
      ui.pairCode.value = '';
      state.authenticated = true;
      await refresh(false);
      if (state.authenticated && state.reachable) {
        ui.connectionDialog.close();
        announce('Connected to your PC.');
      }
    } catch (error) {
      if (!error.status) state.reachable = false;
      dialogMessage(error.status === 401 || error.status === 403
        ? 'This invitation was not accepted. Ask for a new personal code.'
        : error.message);
      updateControls();
    } finally {
      ui.pairButton.disabled = false;
      ui.pairButton.textContent = 'Connect to my agent ↗';
    }
  });

  ui.refreshConnection.addEventListener('click', async () => {
    ui.refreshConnection.disabled = true;
    dialogMessage('Checking connection…');
    await refresh(false);
    ui.refreshConnection.disabled = false;
  });

  ui.logoutButton.addEventListener('click', async () => {
    if (ui.logoutButton.disabled) return;
    ui.logoutButton.disabled = true;
    dialogMessage('');
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
      clearPending();
      saveStored(STORE_DRAFT, null);
      ui.messageInput.value = '';
      resizeInput();
      stopActivityPolling();
      stopPolling();
      state.authenticated = false;
      state.connected = false;
      state.planUsage = null;
      state.messages = [];
      state.run = null;
      state.conversationId = null;
      notice('');
      renderMessages();
      announce('This device is unpaired.');
    } catch (error) {
      dialogMessage(error.message);
    } finally {
      ui.logoutButton.disabled = false;
    }
  });

  window.addEventListener('online', () => void refresh(false));
  window.addEventListener('offline', () => {
    state.reachable = false;
    notice(state.run ? 'This device is offline. Your PC may still be working.' : 'This device is offline. Reconnect to continue.', '', null, 'error');
    updateControls();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh(false);
  });
  window.createNemoViewport({ onResize() {
    // Preserve an older message's reading position; only follow the bottom when
    // the reader was already there before the keyboard changed the layout.
    if (state.followLatest) requestAnimationFrame(() => scrollToLatest());
  } });

  integrations = window.createNemoIntegrations({ api, onUnauthorized: requirePairing, onChange: updateControls, announce });

  const draft = readStored(STORE_DRAFT);
  ui.deviceName.value = /iPhone/.test(navigator.userAgent || '') ? 'iPhone' : /iPad/.test(navigator.userAgent || '') ? 'iPad' : /Windows/.test(navigator.userAgent || '') ? 'Windows browser' : 'Personal browser';
  if (typeof draft === 'string') ui.messageInput.value = draft;
  resizeInput();
  updateControls();
  function openRequestedPanel() {
    const panel = location.hash;
    if (!['#accounts', '#connection'].includes(panel)) return;
    if (state.restoring) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    if (panel === '#accounts') integrations.open(); else openDialog();
  }
  window.addEventListener('hashchange', openRequestedPanel);
  void refresh(true).then(openRequestedPanel);
  // Heartbeats refresh real availability without announcing every poll.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.run && !state.submitting && !ui.connectionDialog.open) void refresh(false);
  }, 20000);
})();

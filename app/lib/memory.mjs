import { createHash, randomBytes } from 'node:crypto';

const CONFIRMATION_TTL_MS = 120_000;
const CONFIRMATION_CAP = 100;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashTitleContent = (title, content) => createHash('sha256').update(JSON.stringify([title, content])).digest('hex');
const BASE_RESIDUALS = [
  'Original emails and phone calendar events are unchanged.',
  'Gmail’s snippet cache is managed separately in Gmail Sync controls. Clear cache & stop sync also removes indexed email copies.',
  'Earlier exports, backups, other browser histories and external AI provider copies are outside this deletion.',
  'This removes application records; it does not promise physical erasure of disk sectors.',
];
const CALENDAR_RESIDUALS = [
  'Phone originals are unchanged.',
  'A revised event can reappear as a new copy.',
];
const FORGET_RESIDUAL = 'Forgotten notes are recoverable and are not permanently deleted.';
const FAILURE_RESIDUAL = 'One or more items could not be removed. Refresh the list and review what remains.';

export class MemoryError extends Error {
  constructor(status, message, code = 'MEMORY') {
    super(message);
    this.name = 'MemoryError';
    this.status = status;
    this.code = code;
  }
}

const fail = (status, message, code = 'MEMORY') => { throw new MemoryError(status, message, code); };

function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    fail(400, `${label} must be text with at most ${maximum} characters.`);
  }
  return value.trim();
}

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Use only the fields shown in the Memory screen.');
  const keys = Object.keys(input);
  if (keys.length !== allowed.length || allowed.some(key => !Object.hasOwn(input, key)) || keys.some(key => !allowed.includes(key))) {
    fail(400, 'Use only the fields shown in the Memory screen.');
  }
}

function ownerId(owner) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 200 || /[\x00-\x1f]/.test(owner)) fail(400, 'This browser could not be confirmed.');
  return owner;
}

function adapt(error) {
  if (error instanceof MemoryError) throw error;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
  if (status === 409) fail(409, 'That memory changed. Refresh it before editing.', 'MEMORY_CHANGED');
  if (status === 404) fail(404, 'That memory is no longer stored here.', 'MEMORY_NOT_FOUND');
  if (status === 400) fail(400, 'That memory could not be saved.', 'MEMORY');
  fail(503, 'Saved memories are unavailable right now.', 'MEMORY_UNAVAILABLE');
}

function present(item) {
  return {
    id: item.id, origin: item.origin, kind: item.kind, title: item.title, summary: item.summary,
    sourceLabel: item.sourceLabel, createdAt: item.createdAt, updatedAt: item.updatedAt,
    revision: item.revision, status: item.status, canEdit: item.canEdit, canForget: item.canForget, canDelete: item.canDelete,
  };
}

function noteCard(item) {
  const copyKind = item.slug?.startsWith('nemo-notes/gmail/') ? 'email' : item.slug?.startsWith('nemo-notes/calendar/') ? 'calendar' : null;
  const status = item.status === 'forgotten' ? 'forgotten' : 'active';
  return {
    id: `gbrain:${item.slug}`, origin: 'gbrain', kind: copyKind || 'note',
    title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 240) : 'Saved note',
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 400) : '',
    sourceLabel: copyKind ? (copyKind === 'email' ? 'Gmail snippet · mirrored to GBrain' : 'Calendar snapshot · mirrored to GBrain') : 'Explicitly saved in Nemo · GBrain',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 60) : null,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 60) : null,
    revision: typeof item.revision === 'string' && item.revision.length <= 256 ? item.revision : digest(item.slug),
    status, canEdit: !copyKind && status === 'active', canForget: status === 'active', canDelete: true,
  };
}

function slugOf(id) {
  if (typeof id !== 'string' || !id.startsWith('gbrain:')) fail(400, 'Choose a valid stored memory.');
  const slug = id.slice('gbrain:'.length);
  if (!slug.startsWith('nemo-notes/') || slug.length > 240 || /[\x00-\x1f]/.test(slug)) fail(400, 'Choose a valid stored memory.');
  return slug;
}

function storedEventId(id) {
  if (typeof id !== 'string' || !id.startsWith('nemo:calendar:')) fail(400, 'Choose a valid stored memory.');
  const stored = id.slice('nemo:calendar:'.length);
  if (!/^[a-f0-9]{24}$/.test(stored)) fail(400, 'Choose a valid stored memory.');
  return stored;
}

function isIncompleteResult(result) {
  return !result || result.ok === false || result.status === 'incomplete' || result.receipt?.completion === 'incomplete';
}

function purgeCompleted(result) {
  return !!result && result.ok === true && result.status === 'purged' && result.receipt?.completion !== 'incomplete';
}

function reimportBlocked({ action, incomplete, gbrainDeletes, gbrainPurgesCompleted, calendarRemovals, calendarBlocked }) {
  if (action !== 'delete' || incomplete) return false;
  if (gbrainPurgesCompleted !== gbrainDeletes || calendarBlocked !== calendarRemovals) return false;
  return gbrainDeletes > 0 || calendarRemovals > 0;
}

function addResidualStrings(bucket, result) {
  for (const list of [result?.residuals, result?.receipt?.residuals]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (typeof value === 'string' && value.trim() && value.length <= 500 && !value.includes('\0')) bucket.add(value.trim());
    }
  }
}

// Owner-facing inventory and deletion. Writes never call a model. GBrain
// search stays unused here because it hides forgotten notes; list() includes them.
export function createMemoryController({ calendar, gbrain, getChat, clearChat, assertIdle, mirror, profileScoped=false, includeCalendar=true, includeChat=true, now = Date.now, createRequestId = () => globalThis.crypto.randomUUID() }) {
  if (typeof assertIdle !== 'function' || typeof getChat !== 'function' || typeof clearChat !== 'function' || typeof now !== 'function' || typeof createRequestId !== 'function' || !calendar || !gbrain) {
    fail(500, 'Memory is not available.');
  }
  const confirmations = new Map();
  let writeChain = Promise.resolve();
  let pending = 0;

  function exclusive(operation) {
    if (typeof operation !== 'function') fail(400, 'Choose a valid memory action.');
    pending += 1;
    const run = writeChain.catch(() => {}).then(async () => {
      try {
        assertIdle();
        return await operation();
      } finally {
        pending -= 1;
      }
    });
    writeChain = run;
    return run;
  }

  function busy() { return pending > 0; }

  function prune() {
    const clock = now();
    for (const [key, entry] of confirmations) if (entry.expiresAt <= clock) confirmations.delete(key);
  }

  function disconnectedBrain(unavailable = false) {
    return { connected: false, items: [], hasMore: unavailable, excludedPages: 0, unavailable };
  }

  function classify(fetched) {
    const seen = new Set();
    const items = [];
    let excludedPages = 0;
    for (const item of fetched) {
      const slug = item && typeof item === 'object' && typeof item.slug === 'string' ? item.slug : '';
      if (!slug) { excludedPages += 1; continue; }
      if(!includeCalendar&&slug.startsWith('nemo-notes/calendar/'))continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (!slug.startsWith('nemo-notes/') || slug.length > 240 || /[\x00-\x1f]/.test(slug) || `gbrain:${slug}`.length > 300) {
        excludedPages += 1;
        continue;
      }
      items.push(noteCard(item));
    }
    return { items, excludedPages };
  }

  async function loadBrainPages() {
    const fetched = [];
    let offset = 0;
    let hasMore = false;
    try {
      for (let pageNumber = 0; pageNumber < 40 && fetched.length < 2000; pageNumber += 1) {
        const page = await gbrain.list({ limit: 100, offset });
        if (!page || typeof page !== 'object' || !Array.isArray(page.items)) {
          return { connected: true, hasMore: true, unavailable: false, ...classify(fetched) };
        }
        hasMore = page.hasMore === true;
        if (page.items.length === 0) break;
        const room = 2000 - fetched.length;
        const batch = page.items.slice(0, room);
        if (batch.length < page.items.length) hasMore = true;
        fetched.push(...batch);
        offset += batch.length;
        if (!hasMore || fetched.length >= 2000) break;
      }
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      return { connected: true, hasMore: true, unavailable: false, ...classify(fetched) };
    }
    return { connected: true, hasMore, unavailable: false, ...classify(fetched) };
  }

  async function brainItems() {
    try {
      const status = await gbrain.status();
      if (!status || status.connected !== true) return disconnectedBrain(false);
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      return disconnectedBrain(true);
    }
    return loadBrainPages();
  }

  function calendarCard(event, snapshot) {
    const title = typeof event.title === 'string' && event.title.trim() ? event.title.slice(0, 240) : 'Calendar event';
    const start = typeof event.start === 'string' ? event.start : '';
    const end = typeof event.end === 'string' ? event.end : '';
    const allDay = event.allDay === true;
    return {
      id: `nemo:calendar:${event.id}`, origin: 'nemo', kind: 'calendar', title,
      summary: `${start} → ${end}${allDay ? ' · All day' : ''}`,
      sourceLabel: 'iPhone Shortcut · local PC snapshot',
      createdAt: typeof snapshot.syncedAt === 'string' ? snapshot.syncedAt : null,
      updatedAt: typeof snapshot.syncedAt === 'string' ? snapshot.syncedAt : null,
      revision: digest([snapshot.generation || null, event.id, title, start, end, allDay]),
      status: 'active', canEdit: false, canForget: false, canDelete: true,
      contentHash: hashTitleContent(title, `${start}\n${end}\n${allDay}`),
    };
  }

  function chatCard(chat) {
    if (!chat || !Number.isInteger(chat.count) || chat.count <= 0) return null;
    const title = profileScoped ? "This profile's active conversation" : "This browser's conversation";
    const transcript = typeof chat.content === 'string' ? chat.content : '';
    const revision = typeof chat.revision === 'string' && chat.revision.length > 0 && chat.revision.length <= 256
      ? chat.revision : digest([chat.count, chat.updatedAt || null, transcript]);
    return {
      id: 'nemo:chat', origin: 'nemo', kind: 'chat', title,
      summary: `${chat.count} saved messages. ${profileScoped?'Available to this profile’s devices. Other family profiles are separate; other conversations are in History.':'Only this paired browser can view this conversation.'}`,
      sourceLabel: profileScoped?'Nemo active chat · this profile':'Nemo chat history · this browser',
      createdAt: typeof chat.createdAt === 'string' ? chat.createdAt : null,
      updatedAt: typeof chat.updatedAt === 'string' ? chat.updatedAt : null,
      revision, status: 'active', canEdit: false, canForget: false, canDelete: true,
      contentHash: hashTitleContent(title, transcript), transcript,
    };
  }

  async function catalog(owner) {
    ownerId(owner);
    try {
      if (includeCalendar&&typeof calendar.reload === 'function') await calendar.reload();
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      fail(503, 'Calendar storage could not be read.', 'MEMORY_UNAVAILABLE');
    }
    let snapshot;
    try { snapshot = includeCalendar?calendar.inventory():{events:[],connected:false}; }
    catch (error) {
      if (error instanceof MemoryError) throw error;
      fail(503, 'Calendar storage could not be read.', 'MEMORY_UNAVAILABLE');
    }
    if (!snapshot || !Array.isArray(snapshot.events)) fail(503, 'Calendar storage could not be read.', 'MEMORY_UNAVAILABLE');
    let chatRaw;
    try { chatRaw = includeChat?await getChat(owner):{count:0}; }
    catch (error) {
      if (error instanceof MemoryError) throw error;
      fail(503, "This browser's conversation could not be read.", 'MEMORY_UNAVAILABLE');
    }
    const chat = chatRaw && typeof chatRaw === 'object' ? chatRaw : { count: 0 };
    const brain = await brainItems();
    const items = [];
    for (const event of snapshot.events) {
      if (!event || typeof event.id !== 'string' || !/^[a-f0-9]{24}$/.test(event.id)) continue;
      items.push(calendarCard(event, snapshot));
    }
    const conversation = chatCard(chat);
    if (conversation) items.push(conversation);
    items.push(...brain.items);
    return { items, brain, snapshot, chat: { count: Number.isInteger(chat.count) && chat.count > 0 ? chat.count : 0 } };
  }

  function select(items, id) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 300 || /[\x00-\x1f]/.test(id)) fail(400, 'Choose a valid stored memory.');
    const item = items.find(entry => entry.id === id);
    if (!item) fail(404, 'That memory is no longer stored here.', 'MEMORY_NOT_FOUND');
    return item;
  }

  function scopeItems(items, scope) {
    if(scope==='notes')return items.filter(item=>item.kind==='note'&&item.origin==='gbrain');
    if (scope === 'all') return items.slice();
    if (scope === 'gbrain') return items.filter(item => item.origin === 'gbrain');
    if (scope === 'chat') return items.filter(item => item.kind === 'chat');
    if (scope === 'calendar') return items.filter(item => item.kind === 'calendar');
    fail(400, 'Choose a valid memory collection.');
  }

  function gbrainDescription(brain) {
    if (!brain.connected) {
      return brain.unavailable
        ? 'Saved notes could not be listed right now. Chat and calendar copies on this screen are still listed.'
        : 'GBrain is not connected. Chat and calendar copies on this screen are still listed.';
    }
    const parts = [includeCalendar?'Saved notes and the Gmail/calendar copies you chose to mirror. Local embeddings support meaning-based retrieval. Forgotten items stay visible but are excluded from recall.':'Small saved memories and optional Gmail references. Local embeddings support meaning-based retrieval. Forgotten items stay visible but are excluded from recall.'];
    if (brain.excludedPages > 0) parts.push(`${brain.excludedPages} non-note ${brain.excludedPages === 1 ? 'page was' : 'pages were'} excluded from this screen.`);
    if (brain.hasMore) parts.push('Some additional saved pages were not loaded into this screen.');
    return parts.join(' ');
  }

  function pageOptions(params) {
    if (!params || typeof params.get !== 'function') fail(400, 'Use valid search and page options.');
    const q = params.get('q') ?? '';
    const kind = params.get('kind') ?? 'all';
    const origin = params.get('origin') ?? 'all';
    const limit = Number(params.get('limit') ?? 50);
    const offset = Number(params.get('offset') ?? 0);
    if (typeof q !== 'string' || q.length > 500 || !['all', 'note', 'email', 'chat', 'calendar'].includes(kind) || !['all', 'nemo', 'gbrain'].includes(origin)
      || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      fail(400, 'Use valid search and page options.');
    }
    return { q, kind, origin, limit, offset };
  }

  async function readNote(slug) {
    let page;
    try { page = await gbrain.get(slug); }
    catch (error) { adapt(error); }
    if (!page || typeof page !== 'object' || typeof page.title !== 'string' || typeof page.content !== 'string'
      || typeof page.revision !== 'string' || page.revision.length < 1 || page.revision.length > 256) {
      fail(503, 'That saved memory could not be confirmed.', 'MEMORY_UNAVAILABLE');
    }
    return page;
  }

  function fingerprint(parts) {
    const ordered = parts.map(part => ({ id: part.id, revision: part.revision, contentHash: part.contentHash, status: part.status }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return digest(ordered);
  }

  async function bind(selected) {
    const parts = [];
    const expectedRevisions = new Map();
    const contentHashes = new Map();
    const slugs = selected.filter(item => item.origin === 'gbrain').map(item => slugOf(item.id));
    const batch = slugs.length > 1 && typeof gbrain.getMany === 'function' ? await gbrain.getMany(slugs) : null;
    const pages = new Map((batch || []).map(page => [page.slug,page]));
    for (const item of selected) {
      if (item.origin === 'gbrain') {
        const page = pages.get(slugOf(item.id)) || await readNote(slugOf(item.id));
        const contentHash = hashTitleContent(page.title, page.content);
        const status = page.status === 'forgotten' ? 'forgotten' : 'active';
        parts.push({ id: item.id, revision: page.revision, contentHash, status });
        expectedRevisions.set(item.id, page.revision);
        contentHashes.set(item.id, contentHash);
      } else {
        parts.push({ id: item.id, revision: item.revision, contentHash: item.contentHash, status: item.status });
        contentHashes.set(item.id, item.contentHash);
      }
    }
    return { revision: fingerprint(parts), expectedRevisions, contentHashes };
  }

  function sameIds(left, right) {
    if (left.length !== right.length) return false;
    const a = [...left].sort();
    const b = [...right].sort();
    return a.every((id, index) => id === b[index]);
  }

  function previewResiduals(action, selected) {
    const lines = [...BASE_RESIDUALS];
    if (action === 'forget') lines.push(FORGET_RESIDUAL);
    if (selected.some(item => item.kind === 'calendar')) lines.push(...CALENDAR_RESIDUALS);
    if(profileScoped&&selected.some(item=>item.kind==='chat'))lines.push('Other conversations in this profile’s History are not removed here.');
    return lines;
  }

  async function list(owner, params) {
    ownerId(owner);
    const { q, kind, origin, limit, offset } = pageOptions(params);
    const data = await catalog(owner);
    const selected = data.items.filter(item => (kind === 'all' || item.kind === kind) && (origin === 'all' || item.origin === origin)
      && (!q || `${item.title}\n${item.summary}`.toLowerCase().includes(q.toLowerCase())));
    const notesInFilter = ['all','note','email','calendar'].includes(kind) && (origin === 'all' || origin === 'gbrain');
    const excludedCount = Number.isInteger(data.snapshot.excludedCount) && data.snapshot.excludedCount > 0 ? data.snapshot.excludedCount : 0;
    let calendarConnected = false;
    try { calendarConnected = calendar.status()?.connected === true; } catch { calendarConnected = false; }
    return {
      ok: true,
      items: selected.slice(offset, offset + limit).map(present),
      total: selected.length,
      hasMore: offset + limit < selected.length || (data.brain.hasMore && notesInFilter),
      totals: { nemo: data.items.filter(item => item.origin === 'nemo').length, gbrain: data.brain.items.length },
      stores: [
        { id: 'chat', label: 'Nemo conversations', description: profileScoped?'This profile’s active conversation. Open History for its other saved conversations. Other family profiles are separate.':'Saved messages for this paired browser. Other browsers stay private.', count: data.chat.count, connected: true, scope: profileScoped?'This profile':'This browser' },
        { id: 'calendar', label: 'Nemo calendar copies', description: `${excludedCount} exact event copies are excluded from future uploads. Phone originals are unchanged. A revised event can reappear as a new copy.`, count: data.items.filter(item => item.kind === 'calendar' && item.origin === 'nemo').length, connected: calendarConnected, scope: 'Shared on this PC' },
        { id: 'gbrain', label: 'GBrain saved memories', description: gbrainDescription(data.brain), count: data.brain.items.length, connected: data.brain.connected, scope: 'Shared on this PC' },
        { id: 'gmail', label: 'Gmail memory copies', description: 'Searched live through explicit Gmail queries. Optional snippets are also mirrored locally when Gmail Sync and source mirroring are enabled. No full bodies or attachments. Clear/stop Gmail Sync also removes its mirrored copies.', count: data.items.filter(item => item.kind === 'email').length, connected: mirror?.status().sources.gmail === true, scope: 'Shared on this PC' },
      ].filter(store=>(includeCalendar||store.id!=='calendar')&&(includeChat||store.id!=='chat')).map(store=>({...store,...(profileScoped&&store.id!=='chat'?{scope:'This profile on this PC'}:{})})),
      policy: { note: 'Search matches stored titles and previews; open a card for its content. Forgotten notes stay visible here and are left out of recall. Deleting a calendar copy does not change the phone event; a revised event can reappear as a new copy. Gmail and calendar memory items are local mirrored copies, not live mailbox or phone records. Meaning-based retrieval embeds those copies locally. Originals stay unchanged. Earlier exports, backups, other browser histories and external provider copies are outside this screen.' },
    };
  }

  async function get(owner, id) {
    const data = await catalog(owner);
    const item = select(data.items, id);
    if (item.origin === 'gbrain') {
      const page = await readNote(slugOf(item.id));
      const status = page.status === 'forgotten' ? 'forgotten' : 'active';
      return { ok: true, item: { ...present(item), title: page.title.slice(0, 240), content: page.content, revision: page.revision, status, canEdit: item.canEdit && status === 'active', canForget: status === 'active' } };
    }
    const content = item.kind === 'chat' ? item.transcript : `${item.title}\n${item.summary}\nUploaded: ${item.createdAt || 'unknown'}`;
    if (typeof content !== 'string' || content.length > 100_000) fail(503, 'That stored memory is too large to show here.', 'MEMORY_UNAVAILABLE');
    return { ok: true, item: { ...present(item), content } };
  }

  async function writeNote(owner, input, edit) {
    ownerId(owner);
    fields(input, edit ? ['id', 'title', 'content', 'revision'] : ['title', 'content']);
    const title = text(input.title, 120, 'Title');
    const content = text(input.content, 8000, 'Memory');
    let slug;
    let expectedRevision;
    if (edit) {
      slug = slugOf(input.id);
      const page = await readNote(slug);
      if (page.status === 'forgotten') fail(400, 'Only active saved notes can be edited.');
      if (page.kind && page.kind !== 'note') fail(400, 'Mirrored records follow their source. Edit the original or delete this memory copy.');
      if (typeof input.revision !== 'string' || input.revision !== page.revision) fail(409, 'That memory changed. Refresh it before editing.', 'MEMORY_CHANGED');
      expectedRevision = input.revision;
    }
    let page;
    try {
      page = await gbrain.save({ ...(slug ? { slug, expectedRevision } : {}), title, content });
    } catch (error) { adapt(error); }
    if (!page || typeof page.slug !== 'string' || !page.slug.startsWith('nemo-notes/')) fail(503, 'The saved note could not be stored.', 'MEMORY_UNAVAILABLE');
    const savedContent = typeof page.content === 'string' ? page.content : content;
    return { ok: true, item: { ...present(noteCard({ ...page, title: typeof page.title === 'string' ? page.title : title, summary: page.summary || savedContent.slice(0, 400) })), content: savedContent }, ...(page.indexStatus === 'pending' ? { notice: 'Memory saved. Its local vector is not ready yet; retry indexing from Memory.' } : {}) };
  }

  async function previewLocked(owner, input, clear) {
    owner = ownerId(owner);
    fields(input, clear ? ['scope'] : ['id', 'action']);
    const data = await catalog(owner);
    if (clear && data.brain.hasMore && ['notes','gbrain','all'].includes(input.scope)) {
      fail(409, 'Not every saved note could be listed, so this clear was not started.', 'MEMORY_PARTIAL');
    }
    if (clear && !data.brain.connected && ['notes','gbrain'].includes(input.scope)) {
      fail(409, 'Saved notes could not be listed, so this clear was not started.', 'MEMORY_PARTIAL');
    }
    const action = clear ? 'delete' : input.action;
    if (action !== 'forget' && action !== 'delete') fail(400, 'Choose Forget or Delete.');
    const selected = clear ? scopeItems(data.items, input.scope) : [select(data.items, input.id)];
    for (const item of selected) {
      if (action === 'forget' && !item.canForget) fail(400, 'This item supports deletion only.');
      if (action === 'delete' && item.canDelete === false) fail(400, 'This item cannot be deleted.');
    }
    if (selected.length === 0) fail(400, 'Nothing stored in that collection is available to clear.');
    const bound = await bind(selected);
    const requestId = createRequestId();
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) fail(503, 'That memory action could not be confirmed.', 'MEMORY_UNAVAILABLE');
    prune();
    while (confirmations.size >= CONFIRMATION_CAP) confirmations.delete(confirmations.keys().next().value);
    const confirmation = randomBytes(32).toString('hex');
    const expiresAt = now() + CONFIRMATION_TTL_MS;
    confirmations.set(confirmation, {
      owner, action, ids: selected.map(item => item.id), scope: clear ? input.scope : null,
      revision: bound.revision, expectedRevisions: bound.expectedRevisions, contentHashes: bound.contentHashes,
      expiresAt, requestId,
    });
    const labels = {
      notes: 'this profile’s small memories',
      gbrain: 'GBrain saved memories', chat: profileScoped?"this profile's active chat":"this browser's Nemo chat", calendar: profileScoped?'this profile’s calendar snapshot':'the shared calendar snapshot',
      all: profileScoped?'this profile’s active chat, calendar snapshot and GBrain memories':"this browser's Nemo chat, the shared calendar snapshot and GBrain notes",
    };
    const residuals = previewResiduals(action, selected);
    if (clear && input.scope === 'all' && !data.brain.connected) residuals.push('Saved notes were not connected, so they were not included.');
    return {
      ok: true, confirmation, expiresAt, affectedCount: selected.length, residuals,
      summary: clear ? `Delete ${selected.length} stored item(s) from ${labels[input.scope]}?` : `${action === 'forget' ? 'Stop recalling' : 'Delete the stored copy of'} "${selected[0].title}"?`,
    };
  }

  async function removeLocked(owner, input) {
    owner = ownerId(owner);
    fields(input, ['confirmation']);
    const token = input.confirmation;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(409, 'This confirmation expired or belongs to another browser. Preview the deletion again.', 'MEMORY_CONFIRMATION');
    prune();
    const entry = confirmations.get(token);
    if (!entry || entry.owner !== owner || entry.expiresAt <= now()) {
      if (entry && (entry.expiresAt <= now() || entry.owner === owner)) confirmations.delete(token);
      fail(409, 'This confirmation expired or belongs to another browser. Preview the deletion again.', 'MEMORY_CONFIRMATION');
    }
    confirmations.delete(token);
    const data = await catalog(owner);
    const selected = entry.scope ? scopeItems(data.items, entry.scope) : entry.ids.map(id => select(data.items, id));
    if (!sameIds(selected.map(item => item.id), entry.ids)) fail(409, 'Stored memories changed after the preview. Review them again.', 'MEMORY_CHANGED');
    const bound = await bind(selected);
    if (bound.revision !== entry.revision) fail(409, 'Stored memories changed after the preview. Review them again.', 'MEMORY_CHANGED');
    for (const item of selected) {
      if (item.origin !== 'gbrain') continue;
      if (bound.expectedRevisions.get(item.id) !== entry.expectedRevisions.get(item.id) || bound.contentHashes.get(item.id) !== entry.contentHashes.get(item.id)) {
        fail(409, 'Stored memories changed after the preview. Review them again.', 'MEMORY_CHANGED');
      }
    }
    const residuals = new Set(previewResiduals(entry.action, selected));
    const removedCalendarIds = [];
    let incomplete = false;
    let removedCount = 0;
    let gbrainDeletes = 0;
    let gbrainPurgesCompleted = 0;
    let calendarRemovals = 0;
    let calendarBlocked = 0;
    let chatCleared = false;
    let batchDeletes = null;
    const brainSelection = selected.filter(item => item.origin === 'gbrain');
    if (entry.action === 'delete' && brainSelection.length > 1 && typeof gbrain.removeMany === 'function') {
      for (const item of brainSelection) await mirror?.exclude(slugOf(item.id));
      const results = await gbrain.removeMany(brainSelection.map(item => ({slug:slugOf(item.id),expectedRevision:entry.expectedRevisions.get(item.id)})),{requestId:entry.requestId,confirm:true});
      batchDeletes = new Map(results.map(result => [result.slug,result]));
    }
    for (const item of selected) {
      try {
        if (item.origin === 'gbrain') {
          const slug = slugOf(item.id);
          const expectedRevision = entry.expectedRevisions.get(item.id);
          if (entry.action === 'delete' && !batchDeletes) await mirror?.exclude(slug);
          const result = entry.action === 'forget'
            ? await gbrain.forget(slug, { requestId: entry.requestId, expectedRevision })
            : batchDeletes ? batchDeletes.get(slug) : await gbrain.remove(slug, { requestId: entry.requestId, expectedRevision, confirm: true });
          addResidualStrings(residuals, result);
          if (entry.action === 'forget') {
            if (isIncompleteResult(result)) incomplete = true;
            else removedCount += 1;
          } else {
            gbrainDeletes += 1;
            if (purgeCompleted(result)) { gbrainPurgesCompleted += 1; removedCount += 1; }
            else incomplete = true;
          }
        } else if (item.kind === 'chat') {
          if (!chatCleared) { await clearChat(owner); chatCleared = true; }
          removedCount += 1;
        } else {
          calendarRemovals += 1;
          const result = await calendar.removeStoredEvents([storedEventId(item.id)]);
          if (!result || result.removedCount !== 1) incomplete = true;
          else {
            removedCount += 1;
            removedCalendarIds.push(storedEventId(item.id));
            if (result.reimportBlocked === true) calendarBlocked += 1;
          }
        }
      } catch (error) {
        if (error instanceof MemoryError) throw error;
        incomplete = true;
        residuals.add(FAILURE_RESIDUAL);
      }
    }
    if (removedCalendarIds.length && mirror) {
      try { await mirror.calendarRemoved(removedCalendarIds); } catch { incomplete = true; residuals.add('Some indexed calendar copies could not be removed. Review Memory and retry.'); }
    }
    const message = incomplete
      ? 'Deletion finished only partly. Some stored items remain.'
      : entry.action === 'forget'
        ? 'The selected memory is no longer available for recall. A recoverable copy remains.'
        : 'The selected application records were removed from this app. Originals outside this app may remain.';
    return {
      ok: true,
      receipt: {
        state: incomplete ? 'incomplete' : 'complete',
        message, removedCount, residuals: [...residuals],
        reimportBlocked: reimportBlocked({ action: entry.action, incomplete, gbrainDeletes, gbrainPurgesCompleted, calendarRemovals, calendarBlocked }),
      },
    };
  }

  return {
    list, get,
    save(owner, input, edit = false) { return exclusive(() => writeNote(owner, input, edit)); },
    preview(owner, input, clear = false) { return exclusive(() => previewLocked(owner, input, clear)); },
    remove(owner, input) { return exclusive(() => removeLocked(owner, input)); },
    exclusive, busy,
  };
}

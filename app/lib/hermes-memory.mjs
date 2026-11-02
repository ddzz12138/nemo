import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { MemoryError } from './memory.mjs';
import { writeJson } from './profile-store.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^hermes:(user|memory):[a-f0-9]{64}$/;
const DEFAULT_CONFIG = 'agent:\n  environment_probe: false\nmemory:\n  provider: builtin\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\ntools:\n  write_approval: false\n';
const emptyExposure = () => ({ version: 1, sources: { gmail: false, calendar: false } });
const fail = (status, message, code = 'MEMORY_UNAVAILABLE') => { throw new MemoryError(status, message, code); };
const unavailable = () => fail(503, 'Your memories could not be read. Try again.', 'MEMORY_UNAVAILABLE');
const ownerError = () => fail(403, 'This memory belongs to a different profile.', 'MEMORY_PROFILE');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function checkedPath(path, directory = false, missing = false) {
  let info;
  try { info = await lstat(path); } catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
  if (info.isSymbolicLink() || (!directory && info.nlink > 1) || (directory ? !info.isDirectory() : !info.isFile())) ownerError();
  return info;
}

async function checkedJson(path, maximum = 262144) {
  const info = await checkedPath(path);
  if (info.size > maximum) unavailable();
  return JSON.parse(await readFile(path, 'utf8'));
}

async function trustedProfile(profileId, profileDataDir, create = false) {
  if (!UUID.test(profileId || '') || typeof profileDataDir !== 'string' || !isAbsolute(profileDataDir)
      || /[\0\r\n]/.test(profileDataDir) || basename(profileDataDir) !== profileId || basename(dirname(profileDataDir)) !== 'profiles') ownerError();
  const requested = resolve(profileDataDir), configuredRoot = dirname(dirname(requested));
  // The host's configured root may be a legitimate Windows junction/short-name
  // alias. Canonicalize that trusted root, then reject links below its boundary.
  const root = await realpath(configuredRoot), directory = join(root, 'profiles', profileId);
  await checkedPath(root, true);
  const registry = await checkedJson(join(root, 'profiles.json'));
  if (registry?.version !== 2 || !Array.isArray(registry.profiles)
      || !registry.profiles.some(profile => profile?.id === profileId && !profile.disabled)) ownerError();
  for (const path of [dirname(directory), directory]) {
    if (!await checkedPath(path, true, create)) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await checkedPath(path, true);
    }
  }
  for (const path of [dirname(requested), requested]) await checkedPath(path, true);
  if (!samePath(await realpath(requested), directory)) ownerError();
  return directory;
}

async function setupLock(directory, operation) {
  const path = join(directory, '.hermes-setup.lock');
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      const candidate = await open(path, 'wx', 0o600);
      try { await candidate.writeFile(JSON.stringify({ pid: process.pid })); handle = candidate; }
      catch (error) { await candidate.close(); await unlink(path).catch(() => {}); throw error; }
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await checkedPath(path);
      let prior;
      try { prior = await checkedJson(path, 1024); } catch { prior = null; }
      let stale = !prior && Date.now() - info.mtimeMs > 30_000;
      if (Number.isSafeInteger(prior?.pid) && prior.pid > 0) {
        try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') stale = true; }
      }
      if (stale) { await unlink(path); continue; }
      if (Date.now() > deadline) fail(503, 'Private memory setup is busy. Try again shortly.', 'MEMORY_BUSY');
      await pause(25);
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(path).catch(() => {}); }
}

// Registry identity -> private writable Hermes home. Runtime bytes stay shared.
// This never imports a global Hermes config, memory, transcript or credential.
export async function prepareHermesWorkspace({ profileId, profileDataDir } = {}) {
  try {
    const directory = await trustedProfile(profileId, profileDataDir, true);
    return await setupLock(directory, async () => {
      const home = join(directory, 'hermes');
      if (!await checkedPath(home, true, true)) {
        try { await mkdir(home, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      await checkedPath(home, true);
      if (!samePath(await realpath(home), join(await realpath(directory), 'hermes'))) ownerError();
      const marker = join(home, 'nemo-profile.json');
      let fresh = false;
      if (!await checkedPath(marker, false, true)) {
        if ((await readdir(home)).length) ownerError();
        await writeJson(marker, { version: 1, profileId });
        fresh = true;
      }
      const saved = await checkedJson(marker, 1024);
      if (Object.keys(saved).length !== 2 || saved.version !== 1 || saved.profileId !== profileId) ownerError();
      const config = join(home, 'config.yaml');
      if (!await checkedPath(config, false, true)) await writeFile(config, DEFAULT_CONFIG, { mode: 0o600, flag: 'wx' });
      const exposure = join(home, 'nemo-memory-state.json');
      if (fresh) await writeJson(exposure, emptyExposure());
      else await checkedPath(exposure, false, true); // Absence remains unknown, never reset to unexposed.
      const memories = join(home, 'memories');
      if (!await checkedPath(memories, true, true)) await mkdir(memories, { mode: 0o700 });
      await checkedPath(memories, true);
      for (const name of ['MEMORY.md', 'USER.md', 'MEMORY.md.lock', 'USER.md.lock']) await checkedPath(join(memories, name), false, true);
      return home;
    });
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    unavailable();
  }
}

const messages = {
  MEMORY_INPUT: 'Use the fields shown in the Memory screen.',
  MEMORY_PROFILE: 'This memory belongs to a different profile.',
  TOOL_PERMISSION: 'Your family owner needs to enable Memory for this profile.',
  MEMORY_CHANGED: 'That memory changed. Refresh it and review the change again.',
  MEMORY_REJECTED: 'Hermes could not save this change. The note may be too long or Memory may be full. Shorten it and try again.',
  MEMORY_STORE: 'Your memories could not be read or changed. Try again.',
  GMAIL_MEMORY_CLEANUP: 'Nemo could not verify saved Gmail details. Clear Memory before changing this Google connection. Your saved notes were preserved.',
  MEMORY_SOURCE_CLEANUP: 'Nemo could not verify saved details from this connection. Clear Memory before changing its access. Your saved notes were preserved.',
};
function knownFields(input, allowed, required = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
}
function validId(value) { if (typeof value !== 'string' || !ID.test(value)) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT'); }
function card(item) {
  return { ...item, content: item.text, title: item.text.replace(/\s+/g, ' ').slice(0, 90), status: 'active',
    category: item.target === 'user' ? 'preferences' : 'personal', source: 'hermes', sourceLabel: 'Hermes memory' };
}

export async function createHermesMemory({ profileId, profileDataDir, command, assertIdle = () => {}, onChanged = async () => {}, now = Date.now } = {}) {
  if (typeof command !== 'function') unavailable();
  const home = await prepareHermesWorkspace({ profileId, profileDataDir });
  let chain = Promise.resolve(), closed = false;
  const confirmations = new Map();
  const serial = operation => { const pending = chain.catch(() => {}).then(operation); chain = pending.catch(() => {}); return pending; };
  const checkOwner = owner => { if (owner !== profileId) ownerError(); };
  const status = () => ({ kind: 'hermes-builtin', automatic: true, connected: !closed, processing: 'hermes' });

  async function invoke(payload) {
    if (closed) unavailable();
    let argv;
    try { await prepareHermesWorkspace({ profileId, profileDataDir }); argv = await command(); }
    catch (error) { if (error instanceof MemoryError) throw error; unavailable(); }
    if (!Array.isArray(argv) || argv.length < 5 || argv.some(value => typeof value !== 'string' || value.includes('\0'))
        || !isAbsolute(argv[0]) || !argv.includes('-I') || !argv.includes('-B') || !argv.includes('-c')) unavailable();
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(key)));
    Object.assign(environment, { HERMES_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_NO_AUTO_INSTALL: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      NEMO_MEMORY_PROFILE_ID: profileId, NEMO_MEMORY_DATA_DIR: dirname(home) });
    const input = JSON.stringify(payload);
    if (input.length > 20000) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
    return await new Promise((resolveResult, reject) => {
      const child = spawn(argv[0], argv.slice(1), { env: environment, cwd: home, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', stopped = false;
      const timer = setTimeout(() => { stopped = true; child.kill(); }, 20000);
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 131072) { stopped = true; child.kill(); } });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new MemoryError(503, messages.MEMORY_STORE, 'MEMORY_UNAVAILABLE')); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          if (stopped || code !== 0) unavailable();
          const value = JSON.parse(output.trim());
          if (value?.ok !== true) {
            const safe = Object.hasOwn(messages, value?.code) ? value.code : 'MEMORY_STORE';
            fail([400, 403, 404, 409, 503].includes(value?.status) ? value.status : 503, messages[safe], safe);
          }
          resolveResult(value);
        } catch (error) { reject(error instanceof MemoryError ? error : new MemoryError(503, messages.MEMORY_STORE, 'MEMORY_UNAVAILABLE')); }
      });
      child.stdin.end(input, 'utf8');
    });
  }
  async function snapshot() {
    const result = await invoke({ operation: 'snapshot' });
    if (!Array.isArray(result.items) || result.items.length > 4096 || !/^[a-f0-9]{64}$/.test(result.revision || '')
        || result.items.some(item => !item || !ID.test(item.id || '') || !['user', 'memory'].includes(item.target) || typeof item.text !== 'string'
          || item.text.length > 65536 || !/^[a-f0-9]{64}$/.test(item.revision || ''))) unavailable();
    return result;
  }
  async function mutate(operation) {
    await assertIdle();
    try {
      const value = await operation();
      if (value.changed) await onChanged();
      return value;
    } catch (error) {
      // A killed bridge or failed post-write read cannot prove that nothing
      // persisted. Retire reusable context conservatively on mutation errors.
      try { await onChanged(); } catch { /* Unknown persistence still retires context when the host recovers. */ }
      if (error instanceof MemoryError) throw error;
      unavailable();
    }
  }
  async function board(owner) {
    checkOwner(owner);
    const current = await snapshot(), items = current.items.map(card);
    const summaryItems = items.filter(item => item.target === 'user');
    const segments = summaryItems.map(({ id, text, revision }) => ({ id, text, revision }));
    return { ok: true, ...status(), items, hasMore: false, revision: current.revision,
      summary: { segments, sourceCount: segments.length, totalCount: items.length, truncated: false, revision: digest(segments) },
      learning: { enabled: true, busy: false, processing: 'hermes' }, references: { gmail: [] } };
  }
  async function details(owner, id) {
    checkOwner(owner); validId(id);
    const current = await snapshot(), item = current.items.find(item => item.id === id);
    if (!item) fail(404, 'That memory is no longer saved here.', 'MEMORY_NOT_FOUND');
    return { ok: true, item: card(item), sourceLabel: 'Hermes memory' };
  }
  const controller = {
    async list(owner) { const value = await board(owner); return { ...value, items: value.items }; },
    get: details,
    save(owner, input, edit = false) { return serial(async () => {
      checkOwner(owner); knownFields(input, ['id', 'revision', 'content', 'title', 'category', 'target'], ['content']);
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4400 || input.content.includes('\0')) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
      if (input.category !== undefined && !['personal', 'preferences', 'projects', 'people'].includes(input.category)) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
      if (edit) { validId(input.id); if (!/^[a-f0-9]{64}$/.test(input.revision || '')) fail(409, messages.MEMORY_CHANGED, 'MEMORY_CHANGED'); }
      const target = input.target || (input.category === 'preferences' ? 'user' : 'memory');
      if (!['user', 'memory'].includes(target)) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
      const value = await mutate(() => invoke(edit ? { operation: 'replace', id: input.id, revision: input.revision, content: input.content.trim() }
        : { operation: 'add', target, content: input.content.trim() }));
      const item = value.snapshot?.items?.find(item => item.text === input.content.trim() && (!edit ? item.target === target : item.id.startsWith(input.id.split(':').slice(0, 2).join(':') + ':')));
      if (!item) unavailable();
      return { ok: true, item: card(item), notice: 'Memory saved.' };
    }); },
    preview(owner, input, clear = false) { return serial(async () => {
      checkOwner(owner); knownFields(input, clear ? ['scope'] : ['id', 'action'], clear ? ['scope'] : ['id', 'action']);
      if (clear ? input.scope !== 'notes' : !['forget', 'delete'].includes(input.action)) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
      if (!clear) validId(input.id);
      await assertIdle();
      const current = await snapshot(), item = clear ? null : current.items.find(item => item.id === input.id);
      if (!clear && !item) fail(409, messages.MEMORY_CHANGED, 'MEMORY_CHANGED');
      const confirmation = randomBytes(32).toString('hex'), expiresAt = now() + 120000;
      for (const [token, prior] of confirmations) if (prior.expiresAt <= now()) confirmations.delete(token);
      while (confirmations.size >= 100) confirmations.delete(confirmations.keys().next().value);
      confirmations.set(confirmation, { expiresAt, clear, revision: current.revision, item });
      return { ok: true, confirmation, expiresAt, revision: current.revision,
        summary: clear ? `Clear ${current.items.length} saved ${current.items.length === 1 ? 'detail' : 'details'} from Memory?` : 'Forget this saved detail?',
        residuals: ['Your conversations, original emails and calendar events remain unchanged.', 'Automatic memory continues after this change. Details mentioned again can be remembered again.', 'Backups and earlier provider copies are outside this deletion.'] };
    }); },
    remove(owner, input) { return serial(async () => {
      checkOwner(owner); knownFields(input, ['confirmation'], ['confirmation']);
      const entry = confirmations.get(input.confirmation);
      confirmations.delete(input.confirmation);
      if (!entry || entry.expiresAt <= now()) fail(409, 'Review this memory change again before confirming.', 'MEMORY_CONFIRMATION');
      const value = await mutate(() => invoke(entry.clear ? { operation: 'clear', revision: entry.revision }
        : { operation: 'remove', id: entry.item.id, revision: entry.item.revision }));
      const complete = entry.clear ? value.complete === true : true;
      return { ok: complete, receipt: { state: complete ? 'complete' : 'partial', message: complete
        ? entry.clear ? 'Saved Memory cleared. Your conversations remain in History.' : 'Saved detail forgotten. Your conversations remain in History.'
        : 'Memory was only partly cleared. Refresh to review what remains, then try again.' } };
    }); },
  };
  async function correct(owner, input) {
    checkOwner(owner);
    knownFields(input, ['id', 'revision', 'selectedText', 'content'], ['id', 'revision', 'selectedText', 'content']);
    if (typeof input.selectedText !== 'string' || !input.selectedText.trim() || input.selectedText.length > 4400) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
    const { item } = await details(owner, input.id);
    if (item.revision !== input.revision || !item.text.includes(input.selectedText)) fail(409, messages.MEMORY_CHANGED, 'MEMORY_CHANGED');
    return controller.save(owner, { id: input.id, revision: input.revision, content: input.content }, true);
  }
  return { kind: 'hermes-builtin', home, engine: { connected: true, kind: 'hermes-builtin' }, controller,
    curation: { board, details, correct, status: () => ({ enabled: true, processing: 'hermes', busy: false }) }, status,
    async revision() { return 'hermes-private-v1:' + (await snapshot()).revision; },
    markConnectedUse(sources = { gmail: true, calendar: true }) { return serial(() => {
      knownFields(sources, ['gmail', 'calendar']);
      if (Object.values(sources).some(value => typeof value !== 'boolean')) fail(400, messages.MEMORY_INPUT, 'MEMORY_INPUT');
      return invoke({ operation: 'mark-connected', sources: { gmail: sources.gmail === true, calendar: sources.calendar === true } });
    }); },
    assertSourceCleared(source = 'gmail') { return serial(() => invoke({ operation: 'source-cleared', source })); },
    async close() { await chain; closed = true; confirmations.clear(); },
  };
}

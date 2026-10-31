import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

// The OS command line contains only this fixed launcher. Note text, titles,
// search terms and operation arguments travel through stdin JSON. Inside the
// child, that JSON is applied to process.argv; it is not a shell command.
//
// Flags checked against the pinned gbrain-src operation manifest
// (get_page, list_pages, search, put_page, delete_page). Param underscores
// are CLI hyphens. Nothing below was invented:
//   get    <slug> --source-id --include-content --include-deleted --json
//   list   --source-id --limit --offset --include-deleted --json
//   search <query> --source-id --match keyword --mode --limit --offset --snippet-chars --json
//   put    <slug> --source-id --content-origin --source-kind --ingested-via
//          --request-id --expected-revision --content --json
//   delete <slug> --source-id --expected-revision --request-id [--purge] --json
// put_page can read `content` from stdin, but this launcher already consumes
// stdin for the JSON envelope, so the body is the --content value inside that
// envelope. Soft delete is `delete` without --purge. `gbrain forget` deletes
// facts, not pages, so page forget does not call it. --purge is delete_page's
// real boolean. Search rows carry chunk_text (snippet_chars bounds it);
// --match keyword and --mode are real search params.
const BOOTSTRAP = String.raw`
const request = JSON.parse(await Bun.stdin.text());
// Memory subprocesses can use only the installed local embedding service.
// This also blocks cloud expansion, reranking and provider-URL overrides.
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['data:', 'file:'].includes(url.protocol)) return originalFetch(input, options);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '11434' || !['/v1/embeddings','/api/embed','/api/embeddings','/api/tags','/api/version','/v1/models'].includes(url.pathname)) throw new Error('Nemo memory permits local embedding requests only.');
  return originalFetch(input, { ...options, redirect: 'error' });
};
const root = process.env.NEMO_GBRAIN_SOURCE_ROOT;
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
process.argv = [process.execPath, join(root, 'src', 'cli.ts'), ...request.args];
const fromRoot = p => import(pathToFileURL(join(root, p)).href);
const { installCleanupSignalHandlers } = await fromRoot('src/core/serve-invocation.ts');
const { installStdoutPipeDelivery } = await fromRoot('src/core/cli-force-exit.ts');
const { agentJsonGuardMode } = await fromRoot('src/cli/json-guard.ts');
installCleanupSignalHandlers();
installStdoutPipeDelivery(agentJsonGuardMode(request.args));
const { runCli, makeContext } = await fromRoot('src/cli/main.ts');
if (request.batch) {
  // A fixed owner-side batch, never a general operation dispatcher or MCP tool.
  // Share one engine connection so clearing a source does not open 200 engines.
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(join(process.env.GBRAIN_HOME, '.gbrain', 'config.json'), 'utf8'));
  const { createEngine } = await fromRoot('src/core/engine-factory.ts');
  const { operationsByName } = await fromRoot('src/core/operations.ts');
  const engine = await createEngine(config);
  const results = [];
  try {
    await engine.connect(config);
    for (const item of request.batch) {
      if (!['get','delete'].includes(item.action) || typeof item.slug !== 'string' || !/^nemo-notes\/[a-z0-9/_-]+$/.test(item.slug)) throw new Error('Invalid owner batch.');
      const op = operationsByName[item.action === 'get' ? 'get_page' : 'delete_page'];
      const params = { slug: item.slug, source_id: 'default', ...(item.action === 'get' ? { include_content: true, include_deleted: true } : { expected_revision: item.revision, request_id: item.requestId, purge: true }) };
      const ctx = await makeContext(engine, params, op);
      ctx.writeWaitMs = 30000;
      ctx.logger = { info() {}, warn() {}, error() {} };
      try { results.push({ slug: item.slug, ok: true, doc: await op.handler(ctx, params) }); }
      catch (error) { results.push({ slug: item.slug, ok: false, code: typeof error?.code === 'string' ? error.code : 'operation_failed' }); }
    }
  } finally { await engine.disconnect(); }
  process.stdout.write(JSON.stringify({ results }));
  process.exit(0);
} else runCli();
`;

export class GbrainError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'GbrainError';
    this.code = code;
    this.status = status;
  }
}

const COMPLETE_PURGE_MESSAGE = 'Cleared from the GBrain live stores covered by this receipt. This does not erase originals, earlier chat copies, provider copies, exports, backups, or unused disk blocks.';
const INCOMPLETE_PURGE_MESSAGE = 'The purge did not finish. Some copies may remain in the memory database until a completed purge. This is not permanent erasure.';
const FORGET_MESSAGE = 'This page is hidden from recall. A recoverable copy and its history remain until you purge it.';
const PURGE_RESIDUALS = [
  'Original source material outside this memory database',
  'Earlier chat copies, exports, provider copies and backups',
  'Other pages may still contain similar information',
];
const FORGET_RESIDUALS = [
  'A recoverable copy and its history remain until you purge this page',
  'Earlier chat copies, exports, provider copies and backups may remain',
];
const RECEIPT_LIMIT = 64;

const disconnected = () => ({ connected: false, available: false, reason: 'not_configured', automaticCapture: false, paidProcessing: false });
const unavailable = () => new GbrainError('GBRAIN_NOT_CONNECTED', 'Nemo memory is not connected to its local GBrain database.');
const preserved = () => new GbrainError('GBRAIN_OPERATION', 'The memory database could not complete this action. Your existing memories have been preserved.');

const queues = new Map();
function serialize(key, operation) {
  const prior = queues.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit) : '';
function boundedText(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  return text.slice(0, limit);
}
function slugValue(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-z0-9][a-z0-9/_-]*$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new GbrainError('GBRAIN_ARGUMENT', 'Choose a valid saved memory.', 400);
  }
  return value;
}
function noteSlug(value) {
  const slug = slugValue(value);
  if (!slug.startsWith('nemo-notes/')) throw new GbrainError('GBRAIN_ARGUMENT', 'Save notes under nemo-notes only.', 400);
  return slug;
}
function numberValue(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new GbrainError('GBRAIN_ARGUMENT', 'The memory page options are invalid.', 400);
  return value;
}
function requestValue(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new GbrainError('GBRAIN_ARGUMENT', 'The memory request identifier is invalid.', 400);
  return value;
}
function revisionValue(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(value)) throw new GbrainError('GBRAIN_ARGUMENT', 'Refresh this memory before editing.', 400);
  return value;
}
function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function containsSecret(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  return Object.entries(value).some(([key, child]) => (
    /(api[_-]?key|client_secret|access_token|guardrails_module|provider_base_urls)/i.test(key) && child
  ) || containsSecret(child, depth + 1));
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}
function childEnvironment(sourceRoot, dataDir) {
  // Platform execution necessities only. Provider keys, database URLs, proxy
  // endpoints, NODE_OPTIONS and model configuration stay out of the child.
  const env = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    GBRAIN_HOME: dataDir,
    GBRAIN_SOURCE: 'default',
    GBRAIN_BRAIN_ID: 'host',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_NO_RETRY_CONNECT: '1',
    NEMO_GBRAIN_SOURCE_ROOT: sourceRoot,
    NO_COLOR: '1',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
  };
}
function publicFailure(doc) {
  const codes = [doc?.code, doc?.error, doc?.write_error, doc?.reason].filter(value => typeof value === 'string');
  if (codes.some(code => ['page_not_found', 'not_found'].includes(code))) return new GbrainError('GBRAIN_NOT_FOUND', 'That saved memory is no longer available.', 404);
  if (codes.some(code => ['revision_conflict', 'revision_changed', 'page_exists', 'already_exists', 'write_conflict', 'idempotency_conflict'].includes(code))) {
    return new GbrainError('GBRAIN_CONFLICT', 'This memory changed. Refresh it before trying again.', 409);
  }
  if (codes.includes('purged_content')) return new GbrainError('GBRAIN_PURGED', 'This content was deleted and is blocked from being saved again.', 409);
  if (codes.some(code => code === 'pglite_busy' || code === 'database_locked' || code === 'busy')) return new GbrainError('GBRAIN_BUSY', 'The memory database is busy. Please try again.', 503);
  return preserved();
}
function parseJsonDocument(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { /* stdout may carry a prefix before the document */ }
  const starts = [];
  for (const match of trimmed.matchAll(/(^|\n)\s*[[{]/g)) starts.push(match.index + match[0].length - 1);
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(trimmed.slice(starts[index])); } catch { /* try an earlier document */ }
  }
  return undefined;
}
function rowForgotten(page) {
  return Boolean(page && (page.deleted_at || page.deletedAt || page.deleted === true));
}
function authoritativeRevision(page) {
  const title = typeof page.title === 'string' ? page.title.trim() : '';
  for (const value of [page.revision, page.knowledge_revision, page.content_hash]) {
    if (typeof value !== 'string') continue;
    const revision = value.trim();
    if (!revision || revision.length > 256 || revision === title || !/^[A-Za-z0-9:_-]+$/.test(revision)) continue;
    return revision;
  }
  return undefined;
}
function excerptFrom(page, content) {
  const frontmatter = page.frontmatter && typeof page.frontmatter === 'object' ? page.frontmatter : {};
  for (const value of [page.chunk_text, page.snippet, page.excerpt, page.description, frontmatter.description, content]) {
    const text = boundedText(value, 1200);
    if (text) return text;
  }
  return '';
}
function projectPage(page, { includeContent = false } = {}) {
  if (!page || typeof page !== 'object' || typeof page.slug !== 'string') throw new GbrainError('GBRAIN_RESPONSE', 'The memory database returned an unexpected result.');
  const frontmatter = page.frontmatter && typeof page.frontmatter === 'object' ? page.frontmatter : {};
  let content = typeof page.content === 'string' ? page.content : typeof page.body === 'string' ? page.body : typeof page.compiled_truth === 'string' ? page.compiled_truth : '';
  content = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const excerpt = excerptFrom(page, content);
  const slug = slugValue(page.slug);
  const result = {
    slug,
    title: clean(page.title || frontmatter.title || slug, 160),
    summary: excerpt,
    excerpt,
    status: rowForgotten(page) ? 'forgotten' : 'active',
    origin: 'gbrain',
    kind: slug.startsWith('nemo-notes/gmail/') ? 'email' : slug.startsWith('nemo-notes/calendar/') ? 'calendar' : 'note',
    sourceLabel: slug.startsWith('nemo-notes/gmail/') ? 'Gmail snippet · mirrored locally' : slug.startsWith('nemo-notes/calendar/') ? 'iPhone calendar · mirrored locally' : 'Saved in Nemo',
  };
  const revision = authoritativeRevision(page);
  if (revision) result.revision = revision;
  for (const [target, values] of [['createdAt', [page.created_at_iso, page.created_at, page.createdAt]], ['updatedAt', [page.updated_at_iso, page.updated_at, page.updatedAt]]]) {
    const value = values.find(item => typeof item === 'string');
    if (value) result[target] = clean(value, 60);
  }
  if (includeContent) result.content = clean(content, 20_000);
  return result;
}
function projectStore(item) {
  if (!item || typeof item !== 'object') return null;
  const store = clean(typeof item.store === 'string' ? item.store : '', 100);
  if (!store) return null;
  const projected = { store, status: clean(typeof item.status === 'string' ? item.status : '', 40) };
  if (Number.isSafeInteger(item.removed) && item.removed >= 0) projected.removed = item.removed;
  if (Number.isSafeInteger(item.remaining) && item.remaining >= 0) projected.remaining = item.remaining;
  return projected;
}
function bucketFor(status) {
  if (status === 'deleted' || status === 'not_present') return 'deleted';
  if (status === 'retained_inactive' || status === 'incomplete' || status === 'out_of_scope' || status === 'would_remove') return 'retained';
  if (status === 'out_of_reach') return 'outOfReach';
  return 'unverified';
}
function bucketStores(items) {
  const buckets = { deleted: [], retained: [], unverified: [], outOfReach: [] };
  for (const item of items) {
    const bucket = buckets[bucketFor(item.status)];
    if (!bucket.includes(item.store)) bucket.push(item.store);
  }
  return buckets;
}
function publicState(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : undefined;
}
function projectPurge(slug, doc) {
  const receipt = doc?.receipt && typeof doc.receipt === 'object' ? doc.receipt : {};
  const stores = Array.isArray(receipt.stores) ? receipt.stores.map(projectStore).filter(Boolean) : [];
  const residualStores = Array.isArray(receipt.residuals) ? receipt.residuals.map(projectStore).filter(Boolean) : [];
  const seen = new Set(stores.map(item => `${item.store}:${item.status}`));
  const combined = [...stores, ...residualStores.filter(item => !seen.has(`${item.store}:${item.status}`))];
  // Only the exact completion string "complete" is a finished purge.
  // "committed" means the transaction landed while verification is still open.
  const complete = receipt.completion === 'complete';
  const state = publicState(doc?.state);
  return {
    ok: complete,
    action: 'delete',
    slug,
    status: complete ? 'purged' : 'incomplete',
    recoverable: false,
    message: complete ? COMPLETE_PURGE_MESSAGE : INCOMPLETE_PURGE_MESSAGE,
    ...(state ? { state } : {}),
    stores,
    residuals: PURGE_RESIDUALS,
    physicalErasure: false,
    receipt: {
      completion: typeof receipt.completion === 'string' ? clean(receipt.completion, 40) : '',
      stores,
      residuals: residualStores,
      ...bucketStores(combined),
      physicalErasure: false,
    },
  };
}
function guard(operation) {
  return Promise.resolve().then(operation).catch(error => {
    if (error instanceof GbrainError) throw error;
    throw preserved();
  });
}

export function createGbrainClient({ runtimePath, sourceRoot, dataDir, spawn = nodeSpawn, timeoutMs = 30_000 } = {}) {
  for (const path of [runtimePath, sourceRoot, dataDir]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 2048 || path.split(/[\\/]/).includes('..')) {
      throw new GbrainError('GBRAIN_CONFIG', 'Nemo memory needs a valid local runtime configuration.');
    }
  }
  if (!/^bun(?:\.exe)?$/i.test(basename(runtimePath))) throw new GbrainError('GBRAIN_CONFIG', 'Nemo memory needs its configured Bun runtime.');
  sourceRoot = resolve(sourceRoot);
  dataDir = resolve(dataDir);
  runtimePath = resolve(runtimePath);
  const receiptPath = join(dataDir, '.gbrain', 'nemo-receipts.json');
  const lockPath = join(dataDir, '.gbrain', 'nemo-engine.lock');

  async function readLocalConfig() {
    const configPath = join(dataDir, '.gbrain', 'config.json');
    if ((await stat(configPath)).size > 65_536) throw unavailable();
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const expectedDatabase = resolve(dataDir, '.gbrain', 'brain.pglite');
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.engine !== 'pglite' || (config.embedding_disabled !== true && (config.embedding_model !== 'ollama:nomic-embed-text' || config.embedding_dimensions !== 768))
      || config.database_url || config.remote_mcp || typeof config.database_path !== 'string' || !samePath(config.database_path, expectedDatabase)
      || config.memory?.auto_writeback !== 'off' || containsSecret(config)) throw unavailable();
    for (const filename of ['.env', 'env']) {
      try {
        await stat(join(dataDir, '.gbrain', filename));
        throw unavailable();
      } catch (error) {
        if (error instanceof GbrainError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return config;
  }
  async function requireLocalConfig() {
    try {
      return await readLocalConfig();
    } catch (error) {
      if (error instanceof GbrainError) throw error;
      throw unavailable();
    }
  }
  async function staleLock() {
    let raw;
    try { raw = await readFile(lockPath, 'utf8'); }
    catch (error) { return error?.code === 'ENOENT' ? false : true; }
    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || !Number.isInteger(doc.pid) || doc.pid <= 0) {
        const info = await stat(lockPath);
        return Date.now() - info.mtimeMs > 1000;
      }
      return !processAlive(doc.pid);
    } catch {
      try {
        const info = await stat(lockPath);
        return Date.now() - info.mtimeMs > 1000;
      } catch (error) {
        return error?.code !== 'ENOENT';
      }
    }
  }
  async function withFileLock(operation) {
    await mkdir(join(dataDir, '.gbrain'), { recursive: true });
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw preserved();
        if (await staleLock()) {
          await unlink(lockPath).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw preserved(); });
          continue;
        }
        if (Date.now() - started >= timeoutMs) throw new GbrainError('GBRAIN_BUSY', 'The memory database is busy. Please try again.', 503);
        await delay(40);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        try { await handle.chmod(0o600); } catch { /* Windows exposes only the readonly bit. */ }
        return await operation();
      } finally {
        await handle.close().catch(() => {});
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8'));
          if (current?.token === token) await unlink(lockPath);
        } catch { /* the lock was already released */ }
      }
    }
  }
  function locked(operation) {
    return serialize(dataDir, () => withFileLock(operation));
  }
  function invoke(args, batch) {
    return new Promise((resolveResult, reject) => {
      let child;
      let stdout = '';
      let stderrLength = 0;
      let settled = false;
      let timedOut = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolveResult(value);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { child?.kill(); } catch { /* the child has already exited */ }
        finish(new GbrainError('GBRAIN_TIMEOUT', 'The memory action timed out. Refresh before retrying.'));
      }, timeoutMs);
      try {
        child = spawn(runtimePath, ['--no-env-file', '--eval', BOOTSTRAP], {
          cwd: sourceRoot,
          env: childEnvironment(sourceRoot, dataDir),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!child?.stdout || !child?.stderr || !child?.stdin) { finish(unavailable()); return; }
      } catch { finish(unavailable()); return; }
      child.on('error', () => finish(unavailable()));
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 2_000_000) { try { child.kill(); } catch { /* already gone */ } finish(new GbrainError('GBRAIN_RESPONSE', 'The memory result was too large. Narrow your search.')); }
      });
      child.stderr.on('data', chunk => {
        stderrLength += chunk.length;
        if (stderrLength > 1_000_000) { try { child.kill(); } catch { /* already gone */ } finish(preserved()); }
      });
      child.stdin.on('error', () => {});
      child.on('close', exitCode => {
        if (timedOut) { finish(new GbrainError('GBRAIN_TIMEOUT', 'The memory action timed out. Refresh before retrying.')); return; }
        if (settled) return;
        const doc = parseJsonDocument(stdout);
        if (!doc || typeof doc !== 'object') { finish(new GbrainError('GBRAIN_RESPONSE', 'The memory database returned an unreadable result.')); return; }
        const completion = doc.receipt?.completion;
        const purgeAttempt = args[0] === 'delete' && args.includes('--purge') && typeof completion === 'string';
        const purgeAccepted = purgeAttempt && (completion === 'complete' || completion === 'incomplete' || completion === 'committed');
        const failed = Boolean(doc.error || doc.write_error || doc.status === 'error' || ['failed', 'conflict', 'cancelled'].includes(doc.state));
        if ((!purgeAccepted && exitCode !== 0) || failed || (purgeAttempt && !purgeAccepted)) { finish(publicFailure(doc)); return; }
        finish(null, doc);
      });
      child.stdin.end(JSON.stringify({ args, ...(batch ? { batch } : {}) }));
    });
  }
  async function run(args) {
    await requireLocalConfig();
    return invoke(args);
  }
  async function runBatch(items) {
    await requireLocalConfig();
    if (!Array.isArray(items) || items.length > 500) throw preserved();
    const result = await invoke([], items);
    if (!Array.isArray(result.results) || result.results.length !== items.length) throw preserved();
    return result.results;
  }
  async function readPage(slug, includeDeleted = false) {
    const doc = await run(['get', slugValue(slug), '--source-id', 'default', '--include-content', '--json', ...(includeDeleted ? ['--include-deleted'] : [])]);
    return projectPage(doc.page || doc, { includeContent: true });
  }
  async function revisionForMutation(slug, expectedRevision) {
    if (expectedRevision !== undefined) return revisionValue(expectedRevision);
    const current = await readPage(slug, true);
    if (typeof current.revision !== 'string') throw new GbrainError('GBRAIN_CONFLICT', 'This memory changed. Refresh it before trying again.', 409);
    return current.revision;
  }
  async function readReceiptLog() {
    let raw;
    try { raw = await readFile(receiptPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw preserved();
    }
    if (raw.length > 1_000_000) throw preserved();
    try {
      const doc = JSON.parse(raw);
      return Array.isArray(doc?.entries) ? doc.entries : [];
    } catch { throw preserved(); }
  }
  async function writeReceiptLog(entries) {
    const body = JSON.stringify({ version: 1, entries: entries.slice(-RECEIPT_LIMIT) });
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    await mkdir(join(dataDir, '.gbrain'), { recursive: true });
    await writeFile(temporary, body, { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* best-effort on Windows */ }
    try {
      await rename(temporary, receiptPath);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
        await unlink(temporary).catch(() => {});
        throw preserved();
      }
      await unlink(receiptPath).catch(() => {});
      try { await rename(temporary, receiptPath); }
      catch { await unlink(temporary).catch(() => {}); throw preserved(); }
    }
    try { await chmod(receiptPath, 0o600); } catch { /* best-effort on Windows */ }
  }
  function findReceipt(entries, requestId, slug, action) {
    const hit = entries.find(entry => entry && entry.requestId === requestId && entry.slug === slug);
    if (!hit) return null;
    if (hit.slug !== slug || hit.action !== action || !hit.result || typeof hit.result !== 'object') {
      throw new GbrainError('GBRAIN_CONFLICT', 'This memory request was already used for a different action.', 409);
    }
    return hit.result;
  }
  async function rememberReceipt(requestId, slug, action, result) {
    const entries = (await readReceiptLog()).filter(entry => entry?.requestId !== requestId || entry?.slug !== slug);
    const stored = structuredClone(result);
    for (const key of ['content', 'title', 'summary', 'excerpt', 'chunk_text', 'body', 'compiled_truth']) delete stored[key];
    entries.push({ requestId, slug, action, result: stored });
    await writeReceiptLog(entries);
  }
  function rowsOf(doc) {
    if (Array.isArray(doc)) return doc;
    if (Array.isArray(doc?.results)) return doc.results;
    if (Array.isArray(doc?.pages)) return doc.pages;
    if (Array.isArray(doc?.items)) return doc.items;
    return [];
  }
  function mutationRequestId(requestId, slug, action) {
    const value=createHash('sha256').update(JSON.stringify([requestId,slug,action])).digest('hex');
    return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;
  }
  async function allStoredRows() {
    const rows = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const doc = await run(['list', '--source-id', 'default', '--limit', '100', '--offset', String(offset), '--include-deleted', '--json']);
      const page = rowsOf(doc);
      rows.push(...page);
      if (page.length < 100) return rows;
    }
    throw new GbrainError('GBRAIN_LIMIT', 'Too many memory records to mirror safely. Clear a collection first.', 409);
  }

  return {
    async status() {
      try {
        const config = await requireLocalConfig();
        await stat(runtimePath);
        await stat(join(sourceRoot, 'src', 'cli.ts'));
        const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
        // Opening the database does not show that search or purge succeeded.
        await locked(() => run(['list', '--source-id', 'default', '--limit', '1', '--json']));
        return {
          connected: true,
          available: true,
          engine: 'pglite',
          embedding: config.embedding_disabled === true ? 'disabled' : 'local-ollama',
          ...(config.embedding_disabled === true ? {} : { embeddingModel: 'nomic-embed-text', embeddingDimensions: 768, searchMode: 'hybrid', processing: 'local' }),
          writeback: 'off',
          version: clean(typeof pkg?.version === 'string' ? pkg.version : '', 40),
          automaticCapture: false,
          paidProcessing: false,
        };
      } catch { return { ...disconnected(), reason: 'unavailable' }; }
    },
    list({ query = '', limit = 50, offset = 0 } = {}) {
      return guard(() => {
        limit = numberValue(limit, 50, 100);
        offset = numberValue(offset, 0, 10_000);
        if (!limit) throw new GbrainError('GBRAIN_ARGUMENT', 'Choose at least one memory per page.', 400);
        if (query) return this.search({ query, limit, offset });
        return locked(async () => {
          const doc = await run(['list', '--source-id', 'default', '--limit', String(limit + 1), '--offset', String(offset), '--include-deleted', '--json']);
          const rows = rowsOf(doc);
          const items = rows.slice(0, limit).map(page => projectPage(page));
          const hasMore = rows.length > limit || doc?._meta?.pagination?.truncated === true;
          return { items, total: offset === 0 && !hasMore ? items.length : null, hasMore, offset, returnedCount: items.length };
        });
      });
    },
    get(slug) {
      return guard(() => locked(() => readPage(slug, true)));
    },
    getMany(slugs) {
      return guard(() => locked(async () => {
        if (!Array.isArray(slugs) || slugs.length > 2000) throw preserved();
        if (!slugs.length) return [];
        const results=[];
        for(let offset=0;offset<slugs.length;offset+=50) results.push(...await runBatch(slugs.slice(offset,offset+50).map(slug => ({ action: 'get', slug: noteSlug(slug) }))));
        return results.map(result => {
          if (!result.ok) throw publicFailure(result);
          return projectPage(result.doc.page || result.doc, { includeContent: true });
        });
      }));
    },
    removeMany(items, { requestId = randomUUID(), confirm = false } = {}) {
      return guard(() => locked(async () => {
        if (!confirm || !Array.isArray(items) || items.length > 2000) throw preserved();
        requestValue(requestId);
        const batch = items.map(item => ({ action:'delete', slug:noteSlug(item.slug), revision:revisionValue(item.expectedRevision), requestId:mutationRequestId(requestId,item.slug,'delete') }));
        if (!batch.length) return [];
        const raw=[];
        for(let offset=0;offset<batch.length;offset+=50)raw.push(...await runBatch(batch.slice(offset,offset+50)));
        const results = raw.map(result => result.ok ? projectPurge(result.slug,result.doc) : {ok:false,slug:result.slug,status:'incomplete',message:INCOMPLETE_PURGE_MESSAGE,residuals:PURGE_RESIDUALS});
        for (const result of results) if (result.ok) await rememberReceipt(requestId,result.slug,'delete',result);
        return results;
      }));
    },
    search({ query, limit = 10, offset = 0, source = 'notes' } = {}) {
      return guard(() => {
        if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\x00-\x1f\x7f]/.test(query)) throw new GbrainError('GBRAIN_ARGUMENT', 'Enter a valid memory search.', 400);
        limit = numberValue(limit, 10, 100);
        offset = numberValue(offset, 0, 10_000);
        if (!limit) throw new GbrainError('GBRAIN_ARGUMENT', 'Choose at least one memory per page.', 400);
        if (!['all','notes','gmail'].includes(source)) throw new GbrainError('GBRAIN_ARGUMENT', 'Choose a valid memory source. Calendar stays in its separate connection.', 400);
        const term = query.trim();
        return locked(async () => {
          const config = await requireLocalConfig();
          const match = config.embedding_disabled === true ? 'keyword' : 'hybrid';
          const fetchLimit = 100;
          const doc = await run(['search', term, '--source-id', 'default', '--match', match, '--mode', 'conservative', '--limit', String(fetchLimit), '--offset', String(offset), '--snippet-chars', '1200', '--json']);
          const raw = rowsOf(doc);
          const active = raw.filter(row => row && typeof row === 'object' && row.slug?.startsWith('nemo-notes/')&&!row.slug.startsWith('nemo-notes/calendar/')&&!rowForgotten(row) && (source==='all'||(source==='notes'?!row.slug.startsWith('nemo-notes/gmail/'):row.slug.startsWith('nemo-notes/gmail/'))));
          const items = active.slice(0, limit).map(page => projectPage(page));
          const hasMore = active.length > limit || raw.length > limit || doc?.has_more === true || doc?.hasMore === true;
          return { items, total: offset === 0 && !hasMore ? items.length : null, hasMore, returnedCount: items.length, query: term };
        });
      });
    },
    save({ slug, title, content, expectedRevision, requestId = randomUUID() } = {}) {
      return guard(() => {
        if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\x00-\x1f\x7f]/.test(title) || typeof content !== 'string' || !content.trim() || content.length > 16_000) {
          throw new GbrainError('GBRAIN_ARGUMENT', 'Give this memory a title and text of at most 16,000 characters.', 400);
        }
        slug = noteSlug(slug || `nemo-notes/${randomUUID()}`);
        if (expectedRevision !== undefined) revisionValue(expectedRevision);
        requestId = requestValue(requestId);
        const markdown = `---\ntitle: ${JSON.stringify(title.trim())}\ntype: note\nvisibility: private\n---\n\n${content.trim()}\n`;
        return locked(async () => {
          await run(['put', slug, '--source-id', 'default', '--content-origin', 'user_said', '--source-kind', 'nemo_explicit', '--ingested-via', 'nemo', '--request-id', requestId, ...(expectedRevision ? ['--expected-revision', expectedRevision] : []), '--content', markdown, '--json']);
          const page = await readPage(slug);
          if ((await requireLocalConfig()).embedding_disabled !== true) {
            try {
              const indexed = await run(['embed', slug, '--source', 'default', '--json']);
              if (indexed.failures > 0 || indexed.reason) throw preserved();
              page.indexStatus = 'ready';
            } catch { page.indexStatus = 'pending'; }
          }
          return page;
        });
      });
    },
    indexPending() {
      return guard(() => locked(async () => {
        if ((await requireLocalConfig()).embedding_disabled === true) throw unavailable();
        const result = await run(['embed', '--stale', '--source', 'default', '--json']);
        if (result.failures > 0 || result.reason) throw preserved();
        return { ok: true, embedded: Number.isSafeInteger(result.embedded) ? result.embedded : 0 };
      }));
    },
    // Host-only source synchronization. No MCP write tool exposes this method.
    mirrorCopies(source, records, excluded = []) {
      return guard(() => locked(async () => {
        if (!['gmail','calendar'].includes(source) || !Array.isArray(records) || records.length > (source === 'gmail' ? 50 : 200) || !Array.isArray(excluded)) throw new GbrainError('GBRAIN_ARGUMENT', 'Choose a bounded source snapshot.', 400);
        const prefix = `nemo-notes/${source}/`;
        const blocked = new Set(excluded);
        const desired = new Map();
        for (const record of records) {
          if (!record || typeof record.id !== 'string' || !record.id || record.id.length > 400 || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 160 || typeof record.content !== 'string' || !record.content.trim() || record.content.length > 8000) throw new GbrainError('GBRAIN_ARGUMENT', 'A source memory is not valid.', 400);
          const slug = prefix + createHash('sha256').update(record.id).digest('hex').slice(0,32);
          if (!blocked.has(slug)) desired.set(slug, record);
        }
        const stored = (await allStoredRows()).filter(page => typeof page?.slug === 'string' && page.slug.startsWith(prefix));
        const current = new Map(stored.map(page => [page.slug,page]));
        const retained = stored.filter(page => desired.has(page.slug) && !rowForgotten(page));
        const retainedPages = new Map();
        if (retained.length) for (const result of await runBatch(retained.map(page=>({action:'get',slug:page.slug})))) {
          if(!result.ok)throw preserved();
          const page=projectPage(result.doc.page||result.doc,{includeContent:true});retainedPages.set(page.slug,page);
        }
        const puts = [];
        const replacements = [];
        for (const [slug,record] of desired) {
          const contentHash = createHash('sha256').update(JSON.stringify([record.title,record.content])).digest('hex');
          const old = current.get(slug);
          // A forgotten copy stays recoverable and hidden until explicitly changed.
          if (old && rowForgotten(old)) continue;
          const page = old ? retainedPages.get(slug) : null;
          if (page && createHash('sha256').update(JSON.stringify([page.title,page.content.trim()])).digest('hex') === contentHash) continue;
          if(page)replacements.push({action:'delete',slug,revision:revisionValue(page.revision),requestId:randomUUID()});
          // A source can be explicitly re-enabled after stop/clear. A new copy
          // has its own admission generation; old purged generations stay gone.
          // Stable exclusions above enforce individual user deletion across all
          // generations. Unchanged live copies never reach this write path.
          puts.push({slug,content:`---\ntitle: ${JSON.stringify(record.title)}\ntype: note\nvisibility: private\nsource_kind: ${source}\nnemo_source_id: ${slug.split('/').at(-1)}\nnemo_copy_generation: ${randomUUID()}\n---\n\n${record.content}\n`});
        }
        // Source mirroring retains the current copy, not a version archive.
        // Purge changed generations (including their old vectors/history) before
        // admitting the replacement. User notes still retain normal edit history.
        for(let offset=0;offset<replacements.length;offset+=50)for(const result of await runBatch(replacements.slice(offset,offset+50))) {
          if(!result.ok||projectPurge(result.slug,result.doc).status!=='purged')throw preserved();
        }
        for (let offset=0; offset<puts.length; offset+=50) {
          const requestId=randomUUID();
          let batch=await run(['put-pages','--pages',JSON.stringify(puts.slice(offset,offset+50)),'--request-id',requestId,'--source-id','default','--wait-ms','30000','--json']);
          for(let attempt=0; batch.state && !['committed','completed'].includes(batch.state) && attempt<3; attempt++) batch=await run(['put-pages','--request-id',requestId,'--source-id','default','--wait-ms','30000','--json']);
          if (batch.state && !['committed','completed'].includes(batch.state)) throw preserved();
        }
        const obsolete = stored.filter(page => !desired.has(page.slug));
        let removed=0;
        if (obsolete.length) {
          const pages = await runBatch(obsolete.map(page => ({action:'get',slug:page.slug})));
          const deletes = pages.map(result => {
            if (!result.ok) throw preserved();
            const page=projectPage(result.doc.page||result.doc,{includeContent:true});
            return {action:'delete',slug:page.slug,revision:revisionValue(page.revision),requestId:randomUUID()};
          });
          for (const result of await runBatch(deletes)) {
            if (!result.ok || projectPurge(result.slug,result.doc).status !== 'purged') throw preserved();
            removed++;
          }
        }
        if (puts.length && (await requireLocalConfig()).embedding_disabled !== true) {
          const result=await run(['embed','--stale','--source','default','--json']);
          if (result.failures>0 || result.reason) throw preserved();
        }
        return {ok:true,source,desiredCount:desired.size,updated:puts.length,replaced:replacements.length,removed};
      }));
    },
    forget(slug, { requestId = randomUUID(), expectedRevision } = {}) {
      return guard(() => {
        slug = slugValue(slug);
        requestId = requestValue(requestId);
        if (expectedRevision !== undefined) revisionValue(expectedRevision);
        return locked(async () => {
          const replay = findReceipt(await readReceiptLog(), requestId, slug, 'forget');
          if (replay) return replay;
          const revision = await revisionForMutation(slug, expectedRevision);
          const doc = await run(['delete', slug, '--source-id', 'default', '--expected-revision', revision, '--request-id', mutationRequestId(requestId,slug,'forget'), '--json']);
          const state = publicState(doc?.state);
          const result = {
            ok: true,
            action: 'forget',
            slug,
            status: 'forgotten',
            recoverable: true,
            message: FORGET_MESSAGE,
            ...(state ? { state } : {}),
            residuals: FORGET_RESIDUALS,
          };
          await rememberReceipt(requestId, slug, 'forget', result);
          return result;
        });
      });
    },
    remove(slug, { requestId = randomUUID(), expectedRevision, confirm = false } = {}) {
      return guard(() => {
        if (confirm !== true) throw new GbrainError('GBRAIN_CONFIRM', 'Confirm deletion before removing this memory.', 400);
        slug = slugValue(slug);
        requestId = requestValue(requestId);
        if (expectedRevision !== undefined) revisionValue(expectedRevision);
        return locked(async () => {
          const replay = findReceipt(await readReceiptLog(), requestId, slug, 'delete');
          if (replay) return replay;
          const revision = await revisionForMutation(slug, expectedRevision);
          const doc = await run(['delete', slug, '--source-id', 'default', '--expected-revision', revision, '--request-id', mutationRequestId(requestId,slug,'delete'), '--purge', '--json']);
          const result = projectPurge(slug, doc);
          if (result.ok === true && result.status === 'purged' && result.receipt.completion === 'complete') {
            await rememberReceipt(requestId, slug, 'delete', result);
          }
          return result;
        });
      });
    },
  };
}

export async function createConfiguredGbrainClient({ nemoDataDir, expectedDataDir } = {}) {
  try {
    if (typeof nemoDataDir !== 'string' || !isAbsolute(nemoDataDir)) throw unavailable();
    const configFile = join(nemoDataDir, 'gbrain-runtime.json');
    if ((await stat(configFile)).size > 8192) throw unavailable();
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['runtimePath', 'sourceRoot', 'dataDir'].includes(key))) throw unavailable();
    if(expectedDataDir && (typeof config.dataDir!=='string'||!samePath(config.dataDir,expectedDataDir)))throw unavailable();
    return createGbrainClient(config);
  } catch {
    return {
      async status() { return disconnected(); },
      async list() { throw unavailable(); },
      async get() { throw unavailable(); },
      async search() { throw unavailable(); },
      async save() { throw unavailable(); },
      async forget() { throw unavailable(); },
      async remove() { throw unavailable(); },
    };
  }
}

// Family/MCP entry point: profile paths are resolved from trusted server
// context. A missing/foreign mapping never opens the old shared database.
export async function createProfileGbrainClient({nemoDataDir,configDir,profileId}={}) {
  if(typeof profileId!=='string'||!/^[a-f0-9-]{36}$/.test(profileId)||typeof configDir!=='string'||!isAbsolute(configDir)||typeof nemoDataDir!=='string'||!isAbsolute(nemoDataDir)||!samePath(nemoDataDir,join(configDir,'profiles',profileId)))throw new GbrainError('GBRAIN_PROFILE','A valid private profile is required for memory.',403);
  return createConfiguredGbrainClient({nemoDataDir,expectedDataDir:join(nemoDataDir,'gbrain-data')});
}

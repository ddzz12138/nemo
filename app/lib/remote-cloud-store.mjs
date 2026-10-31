import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const empty = () => ({ version: 1, installations: {}, enrollments: {}, oauth: {}, sessions: {}, operations: {}, limits: {} });

/** A single-process store. Put it on persistent local disk, never an ephemeral container layer. */
export class RemoteCloudStore {
  #tail = Promise.resolve();
  #state;
  constructor(path = null) { this.path = path; }
  async #load() {
    if (this.#state) return;
    if (!this.path) { this.#state = empty(); return; }
    try {
      const loaded = JSON.parse(await readFile(this.path, 'utf8'));
      if (loaded?.version !== 1 || ['installations', 'enrollments', 'oauth', 'sessions', 'operations', 'limits'].some(key => !loaded[key] || typeof loaded[key] !== 'object' || Array.isArray(loaded[key]))) throw new Error('Invalid remote service database. Restore a valid backup; do not reset installation ownership.');
      this.#state = loaded;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Invalid remote service database. Restore a valid backup; do not reset installation ownership.');
      if (error.code !== 'ENOENT') throw error;
      this.#state = empty();
    }
  }
  async #save(next) {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, this.path);
      // Persist the directory entry on Unix; Windows does not expose directory fsync here.
      if (process.platform !== 'win32') { const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  async transaction(change) {
    const work = this.#tail.then(async () => {
      await this.#load();
      const next = structuredClone(this.#state);
      const result = await change(next);
      await this.#save(next);
      this.#state = next;
      return structuredClone(result);
    });
    this.#tail = work.catch(() => {});
    return work;
  }
  async read(select) {
    await this.#tail;
    await this.#load();
    return structuredClone(select(this.#state));
  }
}

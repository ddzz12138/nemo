/** Admission only. Releasing a slot never retries or dispatches an old task. */
export function createExecutionSlots({ cloud = 2, gpu = 1 } = {}) {
  const limits = { cloud, gpu }, active = { cloud: 0, gpu: 0 }, queue = []; let closed = false;
  if (cloud !== 2 || gpu !== 1) throw new Error('The initial host policy allows two cloud tasks and one heavy GPU job.');
  function drain() {
    if (closed) return;
    queue.sort((a, b) => Number(b.foreground) - Number(a.foreground) || a.order - b.order);
    for (let index = 0; index < queue.length;) {
      const item = queue[index];
      if (active[item.kind] >= limits[item.kind]) { index++; continue; }
      queue.splice(index, 1); item.signal?.removeEventListener('abort', item.cancel); active[item.kind]++;
      let released = false;
      item.resolve(() => { if (released) return; released = true; active[item.kind]--; drain(); });
    }
  }
  let order = 0;
  return {
    acquire({ kind = 'cloud', foreground = true, signal } = {}) {
      if (closed || signal?.aborted || !Object.hasOwn(limits, kind)) return Promise.reject(new Error('This task was not admitted.'));
      return new Promise((resolve, reject) => {
        const item = { kind, foreground, order: order++, signal, resolve, reject, cancel() { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(new Error('This queued task was cancelled before admission.')); } };
        queue.push(item); signal?.addEventListener('abort', item.cancel, { once: true }); drain();
      });
    },
    status() { return { active: { ...active }, queued: queue.length }; },
    close() { closed = true; for (const item of queue.splice(0)) { item.signal?.removeEventListener('abort', item.cancel); item.reject(new Error('The host is stopping.')); } },
  };
}

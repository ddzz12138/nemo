import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createDesktopShutdown } = createRequire(import.meta.url)('../desktop/shutdown.cjs');
const tick = () => new Promise(done => setImmediate(done));

function background() {
  const child = new EventEmitter(); child.sent = [];
  child.postMessage = message => child.sent.push(message.type);
  child.kill = () => assert.fail('Desktop shutdown must never blindly kill the host.');
  return child;
}

test('desktop quit saves sign-in and requires host completion acknowledgement plus clean exit', async () => {
  const child = background(), saved = []; let finishSave;
  const shutdown = createDesktopShutdown({ background: child, saveSession: () => new Promise(done => { finishSave = () => { saved.push(true); done(); }; }) });
  let finished = false; const first = shutdown.request().then(() => { finished = true; });
  assert.deepEqual(child.sent, []); finishSave(); await tick();
  assert.deepEqual(saved, [true]); assert.deepEqual(child.sent, ['shutdown']); assert.equal(finished, false);
  child.emit('message', { type: 'shutdown-complete' }); await tick();
  assert.deepEqual(child.sent, ['shutdown', 'shutdown-ack']); assert.equal(finished, false);
  child.emit('exit', 0); await first; assert.equal(finished, true);
});

test('a forced shutdown deadline keeps the host alive and recognizes its later confirmed cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = background(), shutdown = createDesktopShutdown({ background: child, timeoutMs: 20_000 });
  const waiting = shutdown.request(), rejected = assert.rejects(waiting, { code: 'NEMO_SHUTDOWN_PENDING' });
  await tick(); t.mock.timers.tick(20_000); await rejected;
  assert.deepEqual(child.sent, ['shutdown']);
  child.emit('message', { type: 'shutdown-complete' }); child.emit('exit', 0);
  await shutdown.request(); assert.deepEqual(child.sent, ['shutdown', 'shutdown-ack']);
});

test('failed native cleanup leaves desktop open and a new Quit request can retry the same host', async () => {
  const child = background(), shutdown = createDesktopShutdown({ background: child });
  const first = shutdown.request(), rejected = assert.rejects(first, { code: 'NEMO_SHUTDOWN_FAILED' });
  await tick(); child.emit('message', { type: 'shutdown-failed' }); await rejected;
  const retry = shutdown.request(); await tick(); assert.deepEqual(child.sent, ['shutdown', 'shutdown']);
  child.emit('message', { type: 'shutdown-complete' }); child.emit('exit', 0); await retry;
});

test('unexpected or nonzero host exit never claims confirmed desktop shutdown', async () => {
  for (const acknowledged of [false, true]) {
    const child = background(), shutdown = createDesktopShutdown({ background: child });
    const waiting = shutdown.request(), rejected = assert.rejects(waiting, { code: 'NEMO_SHUTDOWN_UNCONFIRMED' });
    await tick(); if (acknowledged) child.emit('message', { type: 'shutdown-complete' }); child.emit('exit', acknowledged ? 1 : 0); await rejected;
  }
});

test('cookie flush failure leaves the host running and sign-in persistence can be retried', async () => {
  const child = background(); let failSave = true;
  const shutdown = createDesktopShutdown({ background: child, saveSession: async () => { if (failSave) throw new Error('Synthetic cookie flush failed'); } });
  await assert.rejects(shutdown.request()); assert.deepEqual(child.sent, []);
  failSave = false; const retry = shutdown.request(); await tick(); child.emit('message', { type: 'shutdown-complete' }); child.emit('exit', 0); await retry;
});

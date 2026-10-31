import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { main } from '../scripts/setup-gmail-web.mjs';

test('Web client helper uses the existing configured data directory and exact public origin', async () => {
  const calls = [], output = [];
  const current = { dataDir: resolve('synthetic-existing-NemoData'), publicOrigin: 'https://nemo.example.test' };
  const result = await main(['--client', 'synthetic-client.json'], {
    config: async () => current,
    install: async options => { calls.push(options); return { redirectUris: [current.publicOrigin + '/oauth/gmail/callback'] }; },
    output: value => output.push(value), errorOutput: assert.fail,
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, [{ dataDir: current.dataDir, clientPath: resolve('synthetic-client.json'), publicOrigin: current.publicOrigin }]);
  assert.equal(calls[0].dataDir.endsWith('.nemo'), false, 'Do not create a competing legacy root when data already lives elsewhere.');
  assert.ok(output.some(x => x.includes('/oauth/gmail/callback')));
});

test('invalid arguments do not read or import anything; failed configuration prevents all writes', async () => {
  for (const [args, code] of [[[], 1], [['--help'], 0], [['--wrong', 'x'], 1]]) {
    assert.equal(await main(args, { config: assert.fail, install: assert.fail, output() {} }), code);
  }
  const errors = [];
  assert.equal(await main(['--client', 'x'], { config: async () => { throw new Error('Configuration unavailable'); }, install: assert.fail, errorOutput: x => errors.push(x) }), 1);
  assert.deepEqual(errors, ['Configuration unavailable']);
});

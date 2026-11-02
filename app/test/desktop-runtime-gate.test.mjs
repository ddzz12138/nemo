import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { verifyDesktopRuntime } from '../scripts/verify-desktop-runtime.mjs';

const proof = { resident: true, isolated: true, cli: true, dependencies: true };
function fixture() {
  const bundle = { root: resolve('.work/synthetic-selected-release'), connector: { executablePath: 'synthetic-connector' }, node: { executablePath: 'synthetic-node' }, manifest: { node: { version: 'synthetic-node' }, cloudflared: { version: 'synthetic-connector' }, hermes: { verification: { relocated: true, fakeProvider: true }, pmRuntime: { ...proof } } } };
  const checks = [];
  const options = { loadBundle: async () => bundle, scratch: resolve('.work/synthetic-pm-check'),
    verifyAssistant: async value => { checks.push(['assistant', value]); return { extras: ['mcp'], files: 17, dependencies: 4 }; },
    verifyPackageRuntime: async value => { checks.push(['pm', value]); return { ...proof }; } };
  return { bundle, checks, options };
}

test('desktop packaging rejects a PM-less or partially verified runtime despite valid old assistant checks', async () => {
  for (const metadata of [undefined, {}, { ...proof, isolated: false }, { ...proof, cli: 'true' }]) {
    const { bundle, options, checks } = fixture(); bundle.manifest.hermes.pmRuntime = metadata;
    await assert.rejects(verifyDesktopRuntime(options), /isolated Hermes package runtime/);
    assert.equal(checks.some(([kind]) => kind === 'pm'), false, 'a missing isolated runtime must not borrow another resource tree');
  }
});

test('desktop packaging probes stock PM against its exact selected resources and reverifies sealed bytes', async () => {
  const { bundle, options, checks } = fixture();
  const result = await verifyDesktopRuntime(options);
  assert.equal(result.verified, true); assert.deepEqual(result.pmRuntime, proof);
  assert.deepEqual(checks.map(([kind]) => kind), ['assistant', 'pm', 'assistant']);
  for (const [, input] of checks) { assert.equal(input.root, bundle.root); assert.equal(input.manifest, bundle.manifest.hermes); }
  assert.equal(checks[1][1].scratch, options.scratch);
});

test('desktop packaging requires actual PM proof and unchanged sealed bytes after the native probe', async () => {
  const { options } = fixture();
  await assert.rejects(verifyDesktopRuntime({ ...options, verifyPackageRuntime: async () => ({ ...proof, dependencies: false }) }), /isolated runtime checks/);
  await assert.rejects(verifyDesktopRuntime({ ...options, verifyPackageRuntime: async () => { throw new Error('Synthetic native PM failure'); } }), /Synthetic native PM failure/);
  let count = 0;
  await assert.rejects(verifyDesktopRuntime({ ...options, verifyAssistant: async () => { if (++count > 1) throw new Error('Synthetic sealed bytes changed'); return { extras: ['mcp'] }; } }), /sealed bytes changed/);
});

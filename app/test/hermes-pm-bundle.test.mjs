import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareHermesWorkspaceRuntime, stageHermesPackageRuntime, verifyHermesPackageRuntime } from '../lib/hermes-pm-bundle.mjs';

test('package runtime builder requires distinct absolute operator output and leaves existing resources guarded', async () => {
  await assert.rejects(prepareHermesWorkspaceRuntime({ baseRoot: 'relative', out: resolve('output'), artifactCache: resolve('cache') }), /distinct absolute/);
  const root = resolve('.work/desktop-runtime');
  await assert.rejects(prepareHermesWorkspaceRuntime({ baseRoot: root, out: root, artifactCache: resolve('cache') }), /distinct absolute/);
  await assert.rejects(prepareHermesWorkspaceRuntime({ baseRoot: root, out: join(root, 'nested'), artifactCache: resolve('cache') }), /distinct absolute/);
  await assert.rejects(stageHermesPackageRuntime({ root: 'relative', artifactCache: resolve('cache') }), /absolute/);
});

const preview = resolve('.work/assistant-preview-resources/desktop-runtime');
const root = existsSync(join(preview, 'hermes/pm-runtime/pm-runtime.json')) ? preview : resolve('.work/desktop-runtime');
test('actual packaged PM routes stock CLI through separate pinned dependencies with isolated imports', { skip: !existsSync(join(root, 'hermes/pm-runtime/pm-runtime.json')), timeout: 20_000 }, async () => {
  const release = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const proof = await verifyHermesPackageRuntime({ root, manifest: release.hermes, scratch: resolve('.work/native-tools-smoke/pm-verification') });
  assert.deepEqual(proof, { resident: true, isolated: true, cli: true, dependencies: true });
  const inventory = JSON.parse(await readFile(join(root, release.hermes.inventory), 'utf8'));
  assert.deepEqual(inventory.pmRuntime.dependencies.map(row => row.name).sort(), ['packaging', 'ruamel-yaml', 'tomli-w', 'truststore']);
  assert.ok(inventory.files.some(row => row.path === 'hermes/pm-runtime/pm-runtime.json'));
  assert.ok(inventory.files.some(row => row.path === 'hermes/pm-runtime/site-packages/truststore/__init__.py'));
});

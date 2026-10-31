import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedHermesSource, prepareHermesBundle, verifyHermesBundle } from '../lib/hermes-bundle.mjs';
const { pruneEmptyHermesDirectories } = createRequire(import.meta.url)('../desktop/packaging.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, additions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nemo-hermes-bundle-'));
  t.after(async () => { if (!root.startsWith(join(tmpdir(), 'nemo-hermes-bundle-'))) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  const files = { 'hermes/python/python.exe': 'fixture executable', 'hermes/source/hermes_bootstrap.py': '# fixture bootstrap\n', 'hermes/source/LICENSE': 'MIT fixture license', 'hermes/python/LICENSE.txt': 'PSF fixture license', 'hermes/manifest.json': '{"repo":"source","venv":"python","store":"tools"}', ...additions };
  const entries = [];
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); entries.push({ path, sha256: sha(text), size: Buffer.byteLength(text), kind: 'source' }); }
  const inventory = JSON.stringify({ version: 1, packages: [], files: entries });
  await writeFile(join(root, 'hermes/inventory.json'), inventory);
  const manifest = { python: 'hermes/python/python.exe', pythonSha256: sha(files['hermes/python/python.exe']), source: 'hermes/source', inventory: 'hermes/inventory.json', inventorySha256: sha(inventory) };
  let checked;
  const verifyNative = async options => { checked = options.sourceRoot; return { supported: true }; };
  return { root, manifest, verifyNative, get checked() { return checked; } };
}

test('Hermes source policy packages runtime modules and excludes personal state, local installers and caches', () => {
  for (const path of ['run_agent.py', 'hermes_bootstrap.py', 'agent/agent_init.py', 'pm/lock.json', 'LICENSE', 'pyproject.toml', 'skills/example/SKILL.md']) assert.equal(allowedHermesSource(path), true, path);
  for (const path of ['.env', '.env.example', '.hermes/auth.json', '.git/config', 'agent/__pycache__/x.pyc', 'tests/test_agent.py', 'agent/credentials.json', 'sessions.json', 'agent/private.key', 'tools/key.pem', 'apps/desktop/main.py', 'setup-hermes.ps1', '../outside.py', 'agent\\unsafe.py']) assert.equal(allowedHermesSource(path), false, path);
  assert.equal(allowedHermesSource('optional-skills/security/unbroker/SKILL.md'), false);
  for (const path of ['plugins/security-guidance/LICENSE','plugins/security-guidance/NOTICE','skills/productivity/docx/LICENSE']) assert.equal(allowedHermesSource(path), true, path);
});

test('full inventory verifies relative bytes and remains valid after folder relocation', async t => {
  const f = await fixture(t);
  assert.equal((await verifyHermesBundle(f)).verified, true); assert.equal(f.checked, join(f.root, 'hermes/source'));
  const moved = join(f.root, 'relocated'); await mkdir(moved); await cp(join(f.root, 'hermes'), join(moved, 'hermes'), { recursive: true });
  assert.equal((await verifyHermesBundle({ ...f, root: moved })).verified, true);
});

test('changed dependency bytes and unlisted additions invalidate the whole release', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'hermes/python/python.exe'), 'changed executable');
  await assert.rejects(verifyHermesBundle(f), /changed/);
  const g = await fixture(t); await writeFile(join(g.root, 'hermes/source/unreviewed.py'), 'print("not inventoried")');
  await assert.rejects(verifyHermesBundle(g), /absent from/);
});

test('Squirrel payload preparation prevents empty-folder placeholders without relaxing the inventory', async t => {
  const f = await fixture(t);
  const resources = join(f.root, 'resources'), bundle = join(resources, 'desktop-runtime');
  await mkdir(bundle, { recursive: true });
  await cp(join(f.root, 'hermes'), join(bundle, 'hermes'), { recursive: true });
  for (const path of ['python/Lib/encodings/__pycache__', 'source/.hermes/bin']) await mkdir(join(bundle, 'hermes', path), { recursive: true });
  assert.ok(await pruneEmptyHermesDirectories(resources) > 0);
  // Reproduce NuGet's empty-folder transformation on the prepared payload.
  let placeholders = 0;
  async function addNugetPlaceholders(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (!entries.length) { await writeFile(join(directory, '_._'), ''); placeholders++; }
    for (const entry of entries) if (entry.isDirectory()) await addNugetPlaceholders(join(directory, entry.name));
  }
  await addNugetPlaceholders(join(bundle, 'hermes'));
  assert.equal(placeholders, 0);
  assert.equal((await verifyHermesBundle({ ...f, root: bundle })).verified, true);
  await writeFile(join(bundle, 'hermes/source/_._'), '');
  await pruneEmptyHermesDirectories(resources);
  await assert.rejects(verifyHermesBundle({ ...f, root: bundle }), /absent from/);
});

test('inventory digests cannot bless personal state or environment pointers', async t => {
  for (const path of ['hermes/source/auth.json', 'hermes/python/pyvenv.cfg', 'hermes/python/Lib/site-packages/package.dist-info/direct_url.json', 'hermes/python/Lib/site-packages/__editable__.pth']) {
    const f = await fixture(t, { [path]: 'C:\\NemoTest\\private' });
    await assert.rejects(verifyHermesBundle(f), /private|pointer/);
  }
});

test('only reviewed relative PyWin32 pointer and public certifi certificate data are permitted', async t => {
  const good = await fixture(t, { 'hermes/python/Lib/site-packages/pywin32.pth': 'win32\nwin32\\lib\nPythonwin\nimport pywin32_bootstrap\n', 'hermes/python/Lib/site-packages/certifi/cacert.pem': 'public CA certificate fixture' });
  assert.equal((await verifyHermesBundle(good)).verified, true);
  const bad = await fixture(t, { 'hermes/python/Lib/site-packages/pywin32.pth': 'C:\\NemoTest\\site-packages\nimport arbitrary_code\n' });
  await assert.rejects(verifyHermesBundle(bad), /unsafe Python/);
});

test('manifest traversal and altered inventory are refused before a runtime can execute', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyHermesBundle({ ...f, manifest: { ...f.manifest, inventory: '../outside.json' } }), /unsafe/);
  const inventory = JSON.parse(await readFile(join(f.root, f.manifest.inventory), 'utf8')); inventory.files[0].path = 'hermes/../escape.exe';
  const text = JSON.stringify(inventory); await writeFile(join(f.root, f.manifest.inventory), text);
  await assert.rejects(verifyHermesBundle({ ...f, manifest: { ...f.manifest, inventorySha256: sha(text) } }), /unsafe/);
});

test('installer preflight receives extras from the hash-verified inventory', async t => {
  const f = await fixture(t);
  assert.deepEqual((await verifyHermesBundle(f)).extras, []);
  const path = join(f.root, f.manifest.inventory), inventory = JSON.parse(await readFile(path, 'utf8'));
  inventory.extras = ['mcp']; const text = JSON.stringify(inventory); await writeFile(path, text);
  await assert.rejects(verifyHermesBundle(f), /inventory changed/);
  assert.deepEqual((await verifyHermesBundle({ ...f, manifest: { ...f.manifest, inventorySha256: sha(text) } })).extras, ['mcp']);
});

test('runtime preparation requires explicit operator paths and has no parent-facing path guessing', async () => {
  await assert.rejects(prepareHermesBundle({ sourceRoot: 'relative' }), /explicit absolute/);
});

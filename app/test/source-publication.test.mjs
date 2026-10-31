import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublicSource } from '../lib/source-publication.mjs';

test('public inventory accepts maintained build inputs and rejects missing/private/generated inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'desktop/interface/src'), { recursive: true });
  const file = 'desktop/interface/src/main.jsx';
  await writeFile(join(root, file), 'export default function App() { return null; }');
  assert.deepEqual(await verifyPublicSource(root, [file]), { verified: true, files: 1 });
  for (const paths of [null, [], [1], [file,file], ['../outside'], ['/absolute'], ['C:/absolute'], ['a\\b'], ['a//b'], ['.work/private.md'], ['node_modules/pkg/index.js'], ['a/auth.json'], ['a/account.dpapi'], ['a/setup.exe']]) {
    await assert.rejects(verifyPublicSource(root, paths));
  }
  await assert.rejects(verifyPublicSource(root, ['missing.mjs']), /ENOENT/);
  await writeFile(join(root, file), 'const token = "ghp_' + 'A'.repeat(36) + '";');
  await assert.rejects(verifyPublicSource(root, [file]), /Private content/);
  await writeFile(join(root, file), 'https://different-host.' + 'tail' + '012345' + '.ts.net/');
  await assert.rejects(verifyPublicSource(root, [file]), /Private content/);
  await writeFile(join(root, file), Buffer.from([1,0,2]));
  await assert.rejects(verifyPublicSource(root, [file]), /binary/);
});

test('the source inventory retains every file referenced by an npm script', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = new Set(JSON.parse(await readFile(new URL('../source-manifest.json', import.meta.url), 'utf8')));
  for (const command of Object.values(pkg.scripts)) {
    for (const match of command.matchAll(/(?:^|\s)(?!node_modules\/)((?:scripts|desktop|bin|test)\/[\w./-]+\.(?:mjs|cjs|js))/g)) {
      assert.ok(manifest.has(match[1]), `Missing maintained command input: ${match[1]}`);
      await readFile(new URL('../' + match[1], import.meta.url));
    }
  }
});

test('public inventory rejects a linked ancestor and publisher configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-public-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'real')); await writeFile(join(root, 'real/code.mjs'), 'export {};');
  await symlink(join(root, 'real'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyPublicSource(root, ['linked/code.mjs']), /regular/);
  await mkdir(join(root, 'desktop'));
  await writeFile(join(root, 'desktop/google-oauth.json'), '{"version":1,"clientId":"synthetic.apps.googleusercontent.com"}');
  await assert.rejects(verifyPublicSource(root, ['desktop/google-oauth.json']), /configuration/);
  await writeFile(join(root, 'desktop/google-oauth.json'), '{"version":1,"clientId":""}');
  assert.equal((await verifyPublicSource(root, ['desktop/google-oauth.json'])).verified, true);
});

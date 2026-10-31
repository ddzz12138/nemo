import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { verifyNativeRuntime } from './native-compatibility.mjs';

// Optional skill packs are not exposed by Nemo's read-only tool policy. Their
// separate datasets/licences are outside this runtime; retain core code/notices.
const SOURCE_DIRS = new Set(['acp_adapter', 'agent', 'assets', 'cron', 'gateway', 'hermes_cli', 'hermes_platform', 'locales', 'optional-mcps', 'plugin-catalog', 'plugins', 'pm', 'providers', 'skills', 'tools', 'tui_gateway']);
const OMIT_PARTS = new Set(['.git', '.hermes', '.venv', 'venv', '__pycache__', 'node_modules', 'tests', 'test', 'tests-js', '.pytest_cache', '.mypy_cache']);
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value.replaceAll('\\', '/');
const publicCaBundle = path => /^(?:hermes\/)?python\/Lib\/site-packages\/certifi\/cacert\.pem$/.test(path);
function safeRelative(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\0\r\n]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The assistant package contains an unsafe file path.');
  return value;
}
function excluded(path) {
  return path.split('/').some(part => OMIT_PARTS.has(part) || part.startsWith('.env')) || /(?:\.(?:pyc|pyo|sqlite3?|db|dpapi|log|pem|key)|(?:^|\/)(?:auth|credentials|tokens?|sessions?|memories?|config)\.(?:json|ya?ml))$/i.test(path);
}
export function allowedHermesSource(path) {
  try { safeRelative(path); } catch { return false; }
  if (excluded(path)) return false;
  const parts = path.split('/');
  if (parts.length === 1) return /\.py$/.test(path) || ['LICENSE', 'SOUL.md', 'README.md', 'pyproject.toml', 'uv.lock'].includes(path);
  return SOURCE_DIRS.has(parts[0]) && (/\.(?:py|json|ya?ml|md|txt|toml|j2|jinja2|sql|csv|tsv|html|css|js|svg|png|ico|po|mo)$/.test(path) || /^(?:LICENSE|NOTICE|COPYING)(?:[._-][\w.-]+)?$/i.test(parts.at(-1)));
}
async function regularFile(root, name) {
  const path = join(root, safeRelative(name));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The assistant package contains a linked or unsupported file.');
  const base = await realpath(root), actual = await realpath(path), rel = relative(base, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('The assistant package contains a path outside its folder.');
  return { path, info };
}
function execute(executable, args, { cwd, env = process.env, timeoutMs = 60_000, maximum = 32_000_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', value => { stdout += value; if (stdout.length > maximum) { failed = true; child.kill(); } });
    child.stderr.on('data', value => { stderr += value; if (stderr.length > 131_072) { failed = true; child.kill(); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('The assistant build tool could not start.')); });
    child.once('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error(`Assistant build check failed (${failed ? 'timeout or output limit' : code}): ${stderr.slice(-6000)}`)); else resolveRun({ stdout, stderr }); });
  });
}

// Only stdlib and pip's bundled requirement parser are imported. Installed
// distributions are read as metadata; their package code is never imported.
const DEPENDENCY_PLAN = String.raw`
import base64,csv,hashlib,importlib.metadata,json,pathlib,sys,tomllib
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.markers import default_environment
source,site=map(pathlib.Path,sys.argv[1:3])
project=tomllib.loads((source/'pyproject.toml').read_text(encoding='utf-8-sig'))['project']
bundle_extras=['mcp']
for extra in bundle_extras:
    if extra not in project.get('optional-dependencies',{}):raise RuntimeError('Required Nemo dependency extra is absent: '+extra)
norm=lambda x:x.lower().replace('_','-').replace('.','-')
installed={norm(d.metadata['Name']):d for d in importlib.metadata.distributions(path=[str(site)])}
chosen={}; requested={}; queue=[(r,'') for r in project['dependencies']]
for extra in bundle_extras:queue.extend((r,extra) for r in project['optional-dependencies'][extra])
missing=[]
while queue:
    text,extra=queue.pop(0);req=Requirement(text)
    if req.marker and not req.marker.evaluate({**default_environment(),'extra':extra}):continue
    name=norm(req.name);dist=installed.get(name)
    if dist is None:missing.append(str(req));continue
    if req.url:raise RuntimeError('Direct URL dependency requires an explicit wheel build: '+name)
    if req.specifier and not req.specifier.contains(dist.version,prereleases=True):raise RuntimeError('Installed version does not match pinned source: '+name+' '+dist.version+' vs '+str(req.specifier))
    extras=requested.setdefault(name,set());new=set(req.extras)-extras;extras.update(req.extras)
    if name in chosen and not new:continue
    chosen[name]=dist
    for selected in ['',*sorted(extras)]:queue.extend((r,selected) for r in dist.requires or [])
if missing:raise RuntimeError('Missing locked dependencies: '+', '.join(sorted(set(missing))))
files={};packages=[]
for name,dist in sorted(chosen.items()):
    record=dist.read_text('RECORD')
    if not record:raise RuntimeError('Wheel RECORD is missing for '+name)
    packages.append({'name':name,'version':dist.version,'license':dist.metadata.get('License-Expression') or dist.metadata.get('License') or 'See included distribution license','requires':dist.requires or []})
    for row in csv.reader(record.splitlines()):
        if len(row)<3:raise RuntimeError('Malformed wheel RECORD for '+name)
        path,digest,size=row[:3];parts=pathlib.PurePosixPath(path).parts
        if not parts or '..' in parts or pathlib.PurePosixPath(path).is_absolute():continue
        if path.endswith(('/RECORD','/direct_url.json','/INSTALLER','/REQUESTED')) or '__pycache__' in parts or path.endswith(('.pyc','.pyo')) or any(p in {'tests','test'} for p in parts):continue
        if path.endswith('.pth') and path!='pywin32.pth':raise RuntimeError('Unreviewed executable package pointer: '+path)
        if not digest.startswith('sha256='):raise RuntimeError('Unverified wheel file: '+path)
        value=base64.urlsafe_b64decode(digest[7:]+'===')
        item={'path':path,'sha256':value.hex(),'size':int(size),'package':name}
        if path in files and files[path]['sha256']!=item['sha256']:raise RuntimeError('Conflicting dependency file: '+path)
        files[path]=item
print(json.dumps({'extras':bundle_extras,'packages':packages,'files':list(files.values()),'pythonVersion':sys.version.split()[0],'project':{'name':project['name'],'version':project['version']}}))
`;

async function treeFiles(root, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('The assistant package contains a linked folder.');
    if (entry.isDirectory()) paths.push(...await treeFiles(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error('The assistant package contains an unsupported file.');
  }
  return paths;
}
const forbiddenPointer = text => /(?:^|[\r\n])\s*(?:[A-Za-z]:[\\/]|\/|\.\.[\\/])/.test(text) || /(?:__editable__|import\s+_virtualenv|file:\/\/\/|C:[\\/]Users[\\/])/i.test(text);
async function validatePointer(path, bytes) {
  if (!path.endsWith('.pth')) return;
  if (!path.endsWith('/pywin32.pth')) throw new Error('The assistant package contains an unreviewed import pointer.');
  const lines = bytes.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (forbiddenPointer(bytes.toString('utf8')) || lines.some(line => !['win32', 'win32\\lib', 'Pythonwin', 'import pywin32_bootstrap'].includes(line))) throw new Error('The assistant package contains an unsafe Python import pointer.');
}

/** Verifies every bundled byte and refuses added/unlisted source or dependencies. */
export async function verifyHermesBundle({ root, manifest, verifyNative = verifyNativeRuntime } = {}) {
  if (!isAbsolute(root || '') || !manifest || !SHA.test(manifest.inventorySha256 || '')) throw new Error('The assistant package has not been verified.');
  const metadata = await regularFile(root, manifest.inventory);
  const bytes = await readFile(metadata.path);
  if (hash(bytes) !== manifest.inventorySha256 || bytes.length > 20_000_000) throw new Error('The assistant package inventory changed.');
  const inventory = JSON.parse(bytes.toString('utf8'));
  if (inventory.version !== 1 || !Array.isArray(inventory.files) || !inventory.files.length || inventory.files.length > 100_000) throw new Error('The assistant package inventory is invalid.');
  const base = dirname(manifest.inventory), actual = new Set((await treeFiles(join(root, base))).map(name => `${base}/${name}`));
  actual.delete(manifest.inventory);
  for (const item of inventory.files) {
    safeRelative(item.path);
    if (!item.path.startsWith(`${base}/`) || !actual.delete(item.path) || !SHA.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 0 || excluded(item.path.replace(`${base}/source/`, '')) && !publicCaBundle(item.path)) throw new Error('The assistant package contains an unexpected or private file.');
    const { path, info } = await regularFile(root, item.path);
    if (info.size !== item.size) throw new Error('An assistant package file changed.');
    const file = await readFile(path);
    if (hash(file) !== item.sha256) throw new Error('An assistant package file changed.');
    await validatePointer(item.path, file);
    if (/(?:^|\/)(?:pyvenv\.cfg|direct_url\.json)$/.test(item.path)) throw new Error('The assistant package contains a machine-specific environment pointer.');
  }
  if (actual.size) throw new Error('The assistant package contains files absent from its verified inventory.');
  const python = inventory.files.find(item => item.path === manifest.python);
  if (!python || python.sha256 !== manifest.pythonSha256 || !inventory.files.some(item => item.path === `${manifest.source}/hermes_bootstrap.py`)) throw new Error('The assistant interpreter is not in its verified inventory.');
  await verifyNative({ sourceRoot: join(root, manifest.source) });
  return { verified: true, files: inventory.files.length, dependencies: inventory.packages.length, extras: Array.isArray(inventory.extras) ? [...inventory.extras] : [] };
}

export async function prepareHermesBundle({ sourceRoot, pythonRoot, sitePackages, out, onProgress = () => {} } = {}) {
  for (const path of [sourceRoot, pythonRoot, sitePackages, out]) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('The release operator must supply explicit absolute input and output folders.');
  sourceRoot = await realpath(sourceRoot); pythonRoot = await realpath(pythonRoot); sitePackages = await realpath(sitePackages); out = resolve(out);
  if ([sourceRoot, pythonRoot, sitePackages].some(path => { const rel = relative(path, out); return !rel || !rel.startsWith('..') && !isAbsolute(rel); })) throw new Error('The output must be outside all source inputs.');
  await verifyNativeRuntime({ sourceRoot });
  const { stdout: sourceRevision } = await execute('git', ['-C', sourceRoot, 'rev-parse', 'HEAD']);
  const { stdout: changed } = await execute('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=no']);
  if (changed.trim() || !/^[a-f0-9]{40,64}$/.test(sourceRevision.trim())) throw new Error('Build the assistant from a clean tracked source revision. Local edits must be reviewed before packaging.');
  const { stdout: tracked } = await execute('git', ['-C', sourceRoot, 'ls-files', '--cached', '-z']);
  const python = join(pythonRoot, 'python.exe');
  onProgress('Checking pinned Python dependencies against the selected Hermes source.');
  const { stdout: planText } = await execute(python, ['-I', '-B', '-c', DEPENDENCY_PLAN, sourceRoot, sitePackages]);
  const plan = JSON.parse(planText);
  if (!plan.pythonVersion.startsWith('3.14.')) throw new Error('The prepared assistant currently requires standalone Python 3.14.');
  await mkdir(out, { recursive: true });
  try { await lstat(join(out, 'hermes')); throw new Error('An assistant bundle already exists. Preserve it and choose a new output folder.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = join(out, `.hermes-stage-${randomUUID()}`); await mkdir(staging);
  const paths = [], forbidden = [sourceRoot, pythonRoot, sitePackages].flatMap(path => [path, canonical(path), JSON.stringify(path).slice(1, -1)]).map(path => Buffer.from(path.toLowerCase()));
  async function copy(inputRoot, from, to, kind, expected) {
    if (excluded(to.replace('source/', '')) && !publicCaBundle(to)) return;
    const { path, info } = await regularFile(inputRoot, from); const bytes = await readFile(path);
    if (expected && (hash(bytes) !== expected.sha256 || info.size !== expected.size)) throw new Error(`Wheel RECORD verification failed: ${from}`);
    const lower = Buffer.from(bytes.toString('latin1').toLowerCase(), 'latin1');
    if (forbidden.some(pointer => lower.includes(pointer))) throw new Error(`A build-machine path is embedded in ${from}; create a clean wheel before packaging it.`);
    await validatePointer(`hermes/${to}`, bytes);
    const target = join(staging, safeRelative(to)); await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
    paths.push({ path: `hermes/${to}`, sha256: hash(bytes), size: bytes.length, kind });
  }
  onProgress('Copying allowlisted tracked Hermes source and verified dependency files.');
  for (const file of tracked.split('\0').filter(allowedHermesSource)) await copy(sourceRoot, file, `source/${file}`, 'source');
  for (const file of await treeFiles(pythonRoot)) {
    if (file.startsWith('Scripts/') || file.startsWith('include/') || file.startsWith('libs/') || file.startsWith('Lib/site-packages/') || file.startsWith('Lib/ensurepip/') || file.includes('/test/') || file.includes('/tests/') || file.endsWith('.pdb') || excluded(file)) continue;
    if (file.includes('/') && !file.startsWith('Lib/') && !file.startsWith('DLLs/')) continue;
    if (!file.includes('/') && !/^(?:python(?:3|314)?\.dll|python\.exe|vcruntime[0-9_]+\.dll|LICENSE\.txt)$/.test(file)) continue;
    await copy(pythonRoot, file, `python/${file}`, 'python');
  }
  for (const file of plan.files) await copy(sitePackages, file.path, `python/Lib/site-packages/${safeRelative(file.path)}`, 'dependency', file);
  async function generated(path, value) { const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); await mkdir(dirname(join(staging, path)), { recursive: true }); await writeFile(join(staging, path), bytes); paths.push({ path: `hermes/${path}`, sha256: hash(bytes), size: bytes.length, kind: 'metadata' }); }
  await generated('manifest.json', { schema: 1, repo: 'source', venv: 'python', store: 'tools' });
  await generated('source/install-stamp.json', { schema: 1, distribution: 'desktop-app', updateMechanism: 'external', commit: sourceRevision.trim(), tag: `nemo-${sourceRevision.trim().slice(0, 12)}` });
  const dependencyLock = { version: 1, pythonVersion: plan.pythonVersion, extras: plan.extras, packages: plan.packages.map(item => ({ name: item.name, version: item.version })) };
  await generated('dependencies.lock.json', dependencyLock);
  await generated('THIRD_PARTY_NOTICES.txt', ['Nemo bundled assistant runtime', `Hermes source revision: ${sourceRevision.trim()}`, 'Hermes: MIT; see source/LICENSE and nested LICENSE/NOTICE files', 'Python: Python Software Foundation; see python/LICENSE.txt', '', 'Apache-2.0 adapted portions; terms: source/plugins/security-guidance/LICENSE', 'agent/pet/generate/atlas.py: OpenAI hatch-pet.', 'tools/file_tools_write_guards.py: Roo-Code.', 'tools/schema_sanitizer.py: block/goose.', 'tools/vision_tools_image_prep.py: QwenLM/qwen-code; Copyright 2026 Qwen.', 'Original attribution comments are retained beside the code.', '', ...plan.packages.map(item => `${item.name}==${item.version}: ${item.license.replaceAll(/\s+/g, ' ').slice(0, 180)} (full notices under python/Lib/site-packages)`)].join('\n'));
  onProgress('Checking the assistant after moving its folder and using a new empty home.');
  const relocation = await probeRelocated(staging, onProgress);
  // Probe code must never alter release bytes. Refuse unexpected cache/state.
  const actual = new Set(await treeFiles(staging)); for (const item of paths) if (!actual.delete(item.path.slice('hermes/'.length))) throw new Error('A staged assistant file disappeared.');
  if (actual.size) throw new Error(`Runtime wrote into its sealed folder: ${[...actual].slice(0, 5).join(', ')}`);
  const inventory = { version: 1, sourceRevision: sourceRevision.trim(), pythonVersion: plan.pythonVersion, extras: plan.extras, packages: plan.packages, verification: relocation, files: paths.sort((a, b) => a.path.localeCompare(b.path)) };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`); await writeFile(join(staging, 'inventory.json'), inventoryBytes);
  const manifest = { python: 'hermes/python/python.exe', pythonSha256: paths.find(item => item.path === 'hermes/python/python.exe').sha256, source: 'hermes/source', inventory: 'hermes/inventory.json', inventorySha256: hash(inventoryBytes), sourceRevision: sourceRevision.trim(), pythonVersion: plan.pythonVersion, extras: plan.extras, dependencyLockSha256: hash(Buffer.from(`${JSON.stringify(dependencyLock, null, 2)}\n`)), verification: relocation };
  await rename(staging, join(out, 'hermes'));
  await verifyHermesBundle({ root: out, manifest });
  let existing = {}; try { existing = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const release = { ...existing, version: 1, platform: 'win32', arch: 'x64', hermes: manifest };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
  return { root: out, manifest, files: paths.length, dependencies: plan.packages.length };
}

export async function probeHermesBundle({ root, manifest, onProgress = () => {} }) {
  await verifyHermesBundle({ root, manifest });
  const verification = await probeRelocated(join(root, dirname(manifest.inventory)), onProgress);
  const inventoryPath = join(root, manifest.inventory), inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  inventory.verification = verification;
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`); await writeFile(inventoryPath, bytes);
  const updated = { ...manifest, inventorySha256: hash(bytes), verification };
  const releasePath = join(root, 'manifest.json'), release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.hermes = updated; await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  await verifyHermesBundle({ root, manifest: updated });
  return verification;
}

export async function probeRelocated(staging, onProgress = () => {}) {
  const moved = `${staging}-relocated`; await rename(staging, moved);
  // Evidence/state lives OUTSIDE the shipped desktop-runtime directory.
  const scratch = join(dirname(dirname(staging)), 'hermes-runtime-probes', randomUUID()), home = join(scratch, 'new-parent-home'); await mkdir(home, { recursive: true });
  const env = { HERMES_HOME: home, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(scratch, 'local'), APPDATA: join(scratch, 'roaming'), TEMP: scratch, TMP: scratch, HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_NO_AUTO_INSTALL: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1', OPENAI_API_KEY: 'synthetic-only' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const networkGuard = String.raw`import socket
_connect=socket.socket.connect
_connect_ex=socket.socket.connect_ex
def _local(address):
    if not isinstance(address,tuple) or str(address[0]) not in ('127.0.0.1','::1','localhost'):
        raise OSError('Release verification allows only the synthetic loopback provider')
def _guarded_connect(self,address):
    _local(address);return _connect(self,address)
def _guarded_connect_ex(self,address):
    _local(address);return _connect_ex(self,address)
socket.socket.connect=_guarded_connect
socket.socket.connect_ex=_guarded_connect_ex
`;
  const bootstrap = `import os,sys,runpy; sys.dont_write_bytecode=True; sys.path.insert(0,sys.argv.pop(1)); exec(${JSON.stringify(networkGuard)}); import hermes_bootstrap; runpy.run_module('hermes_cli.main',run_name='__main__',alter_sys=True)`;
  try {
    const identity = await execute(join(moved, 'python/python.exe'), ['-I', '-B', '-c', 'import json,sys; print(json.dumps({"prefix":sys.prefix,"executable":sys.executable,"version":sys.version.split()[0]}))'], { cwd: scratch, env });
    const proof = JSON.parse(identity.stdout);
    if (!resolve(proof.executable).startsWith(resolve(moved)) || !resolve(proof.prefix).startsWith(resolve(moved))) throw new Error('The relocated interpreter points outside its release folder.');
    const result = await execute(join(moved, 'python/python.exe'), ['-I', '-B', '-c', bootstrap, join(moved, 'source'), '--help'], { cwd: scratch, env, timeoutMs: 60_000 });
    if (!/usage:|Hermes Agent|hermes chat/i.test(result.stdout)) throw new Error('The relocated assistant did not print its command help.');
    onProgress('Relocated Python and Hermes --help passed with an empty parent profile.');
    await fakeProviderProbe({ moved, scratch, env, networkGuard });
    onProgress('Actual bundled Hermes completed a tool-free turn through the synthetic loopback provider.');
    return { relocated: true, help: true, fakeProvider: true };
  } finally { await rename(moved, staging); }
}

async function fakeProviderProbe({ moved, scratch, env, networkGuard }) {
  let requests = 0;
  const expected = 'Bundled Hermes answered through loopback.';
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const part of request) { text += part; if (text.length > 1_000_000) { response.writeHead(413); return response.end(); } }
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ data: [{ id: 'synthetic-bundle-model', context_length: 131072 }] })); }
    let body; try { body = JSON.parse(text); } catch { response.writeHead(400); return response.end(); }
    if (request.url !== '/v1/chat/completions' || !Array.isArray(body.messages) || body.tools?.length) { response.writeHead(400); return response.end(); }
    requests++;
    const completion = { id: 'chatcmpl_nemo_bundle', object: 'chat.completion', created: 1, model: 'synthetic-bundle-model', choices: [{ index: 0, message: { role: 'assistant', content: expected }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: expected }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(completion)); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const code = String.raw`import json,os,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
exec(sys.argv[3])
import hermes_bootstrap
from run_agent import AIAgent
import openai,run_agent,mcp,jsonschema
from pathlib import Path
_bundle=Path(sys.executable).resolve().parent.parent
assert Path(openai.__file__).resolve().is_relative_to(_bundle),'Provider SDK escaped bundled dependencies'
assert Path(run_agent.__file__).resolve().is_relative_to(_bundle),'Hermes source escaped bundle'
assert Path(mcp.__file__).resolve().is_relative_to(_bundle),'MCP escaped bundled dependencies'
assert Path(jsonschema.__file__).resolve().is_relative_to(_bundle),'MCP schema validation escaped bundle'
agent=AIAgent(model='synthetic-bundle-model',base_url=sys.argv[2],api_key='synthetic-only',provider='custom',api_mode='chat_completions',enabled_toolsets=['none'],max_iterations=1,skip_context_files=True,skip_memory=True,skip_background_review=True,quiet_mode=True,save_trajectories=False,run_budget_seconds=20)
try:
    assert not agent.tools,'A release probe must not execute tools'
    result=agent.run_conversation('Synthetic packaging probe. Reply once without tools.',system_message='Use only the supplied synthetic provider.')
    assert 'Bundled Hermes answered through loopback.' in json.dumps(result),str(result)
    print('NEMO_BUNDLE_REPLY_OK')
finally:
    close=getattr(agent,'close',None)
    if close:close()
`;
  try {
    const result = await execute(join(moved, 'python/python.exe'), ['-I', '-B', '-c', code, join(moved, 'source'), `http://127.0.0.1:${server.address().port}/v1`, networkGuard], { cwd: scratch, env, timeoutMs: 60_000 });
    if (!requests || !result.stdout.includes('NEMO_BUNDLE_REPLY_OK')) throw new Error('The packaged assistant did not complete a synthetic provider turn.');
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

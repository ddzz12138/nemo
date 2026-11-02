import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { verifyHermesBundle } from './hermes-bundle.mjs';
import { downloadPinnedArtifact, validateReleaseInputs } from './release-inputs.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PM_NAMES = new Set(['packaging', 'tomli-w', 'ruamel-yaml', 'truststore']);
const normalize = value => value.toLowerCase().replace(/[-_.]+/g, '-');
const inside = (parent, child) => { const path = relative(parent, child); return path && !path.startsWith('..') && !isAbsolute(path); };

function run(python, args, { env, cwd, timeout = 60_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(python, args, { env, cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, timeout);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2_000_000) { failed = true; child.kill(); } });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 100_000) { failed = true; child.kill(); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('The isolated Hermes package runtime could not start.')); });
    child.once('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error(`Hermes package runtime check failed: ${stderr.slice(-3000)}`)); else resolveRun(stdout); });
  });
}

// The upstream source snapshot has pm/pyproject.toml but no pm/uv.lock. Use its
// exact four pins and the existing checksum-pinned release wheel lock; do not
// synthesize or change an upstream lockfile. The supported resident PM format
// isolates those dependencies while sharing only the verified Python stdlib.
const STAGE = String.raw`
import base64,csv,email,hashlib,importlib.metadata,io,json,pathlib,stat,sys,tomllib,zipfile
from packaging.requirements import Requirement
from packaging.markers import default_environment
source,site=map(pathlib.Path,sys.argv[1:3]); wheels=json.loads(sys.argv[3]); norm=lambda s:s.lower().replace('_','-').replace('.','-')
requirements=[Requirement(x) for x in tomllib.loads((source/'pm'/'pyproject.toml').read_text())['project']['dependencies']]
declared={norm(r.name):r for r in requirements if not r.marker or r.marker.evaluate(default_environment())}
if set(declared)!=set(w['name'] for w in wheels):raise RuntimeError('PM dependency graph changed; review its independent wheel lock')
files=[];packages=[]
for wheel in wheels:
    path=pathlib.Path(wheel['path']);raw=path.read_bytes()
    if len(raw)!=wheel['bytes'] or hashlib.sha256(raw).hexdigest()!=wheel['sha256']:raise RuntimeError('PM wheel integrity failure')
    if not declared[wheel['name']].specifier.contains(wheel['version']):raise RuntimeError('PM exact dependency pin changed')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        records=[name for name in z.namelist() if name.endswith('.dist-info/RECORD')]
        if len(records)!=1:raise RuntimeError('PM wheel RECORD missing')
        rows={row[0]:row for row in csv.reader(io.StringIO(z.read(records[0]).decode()))}
        for info in z.infolist():
            name=info.filename;parts=pathlib.PurePosixPath(name).parts
            if not parts or pathlib.PurePosixPath(name).is_absolute() or '..' in parts or any(':' in p or '\\' in p for p in parts) or stat.S_ISLNK(info.external_attr>>16):raise RuntimeError('Unsafe PM wheel entry')
            if info.is_dir():continue
            if name.endswith(('.pth','.pyc','.pyo')) or name.endswith('/direct_url.json'):raise RuntimeError('Executable or external PM import pointer')
            data=z.read(info);row=rows.get(name)
            if row is None:raise RuntimeError('PM wheel entry absent from RECORD')
            if name!=records[0]:
                if len(row)<3 or not row[1].startswith('sha256=') or int(row[2])!=len(data) or base64.urlsafe_b64decode(row[1][7:]+'===')!=hashlib.sha256(data).digest():raise RuntimeError('PM RECORD digest mismatch')
            target=site/name
            if target.exists() and target.read_bytes()!=data:raise RuntimeError('Conflicting PM wheel file')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
            files.append({'path':name,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        metadata=email.message_from_bytes(z.read(next(n for n in z.namelist() if n.endswith('.dist-info/METADATA'))))
        if norm(metadata['Name'])!=wheel['name'] or metadata['Version']!=wheel['version']:raise RuntimeError('PM wheel metadata differs from lock')
        packages.append({'name':wheel['name'],'version':wheel['version'],'requires':metadata.get_all('Requires-Dist') or []})
installed={norm(d.metadata['Name']):d for d in importlib.metadata.distributions(path=[str(site)])}
for package in packages:
    for text in package['requires']:
        req=Requirement(text)
        if req.marker and not req.marker.evaluate({**default_environment(),'extra':''}):continue
        dep=installed.get(norm(req.name))
        if dep is None or req.url or not req.specifier.contains(dep.version):raise RuntimeError('Unbundled transitive PM dependency: '+req.name)
print(json.dumps({'files':files,'packages':packages}))
`;

export async function verifyHermesPackageRuntime({ root, manifest, scratch }) {
  const python = join(root, manifest.python), source = join(root, manifest.source), site = join(root, 'hermes/pm-runtime/site-packages');
  await mkdir(scratch, { recursive: true });
  const home = join(scratch, 'empty-home'); await mkdir(home, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, HERMES_HOME: home, LOCALAPPDATA: join(home, 'local'), APPDATA: join(home, 'roaming'), TEMP: scratch, TMP: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', NO_COLOR: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  const probe = `import sys,json,pathlib,subprocess;sys.path.insert(0,${JSON.stringify(source)});import hermes_bootstrap;from pm.runtime import runtime_command,runtime_environment;command=runtime_command(pathlib.Path(${JSON.stringify(join(source, 'pm/launch.py'))}),['--help'],bootstrap=False);assert command[0]==${JSON.stringify(python)};assert '-I' in command and '-S' in command and ${JSON.stringify(site)} in command;result=subprocess.run(command,env=runtime_environment(),capture_output=True,text=True,timeout=30);assert result.returncode==0,result.stderr;assert 'install' in result.stdout;print(json.dumps({'resident':True,'isolated':True,'cli':True,'command':command}))`;
  const proof = JSON.parse(await run(python, ['-I', '-B', '-c', probe], { env, cwd: scratch }));
  // -S prevents the shared interpreter's application site-packages from entering
  // the independent PM environment. No ambient import path participates.
  const imports = `import sys,json,pathlib;sys.path.insert(0,${JSON.stringify(site)});import packaging,tomli_w,truststore,ruamel.yaml;roots=[pathlib.Path(m.__file__).resolve() for m in [packaging,tomli_w,truststore,ruamel.yaml]];assert all(p.is_relative_to(pathlib.Path(${JSON.stringify(site)})) for p in roots);assert not any(p.endswith('python/Lib/site-packages') or p.endswith('python\\Lib\\site-packages') for p in sys.path);print(json.dumps({'dependencies':True}))`;
  await run(python, ['-I', '-S', '-B', '-c', imports], { env, cwd: scratch });
  return { resident: proof.resident, isolated: proof.isolated, cli: proof.cli, dependencies: true };
}

/** Preserve a verified base. Produce a fresh resource tree with a real isolated
 * resident PM runtime, never mutate an installed/sealed payload in place. */
export async function prepareHermesWorkspaceRuntime({ baseRoot, out, releaseLock, artifactCache, onProgress = () => {} }) {
  if (![baseRoot, out, artifactCache].every(path => typeof path === 'string' && isAbsolute(path)) || resolve(baseRoot) === resolve(out) || inside(resolve(baseRoot), resolve(out)) || inside(resolve(out), resolve(baseRoot))) throw new Error('Supply distinct absolute base, output and artifact cache paths.');
  validateReleaseInputs(releaseLock);
  const release = JSON.parse(await readFile(join(baseRoot, 'manifest.json'), 'utf8'));
  await verifyHermesBundle({ root: baseRoot, manifest: release.hermes });
  try { await lstat(out); throw new Error('Preserve the prepared runtime and choose a fresh output folder.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  onProgress('Copying the verified assistant into fresh preview resources.');
  await mkdir(resolve(out, '..'), { recursive: true });
  await cp(baseRoot, out, { recursive: true, errorOnExist: true, force: false });
  const result = await stageHermesPackageRuntime({ root: out, releaseLock, artifactCache, onProgress });
  await verifyHermesBundle({ root: baseRoot, manifest: JSON.parse(await readFile(join(baseRoot, 'manifest.json'), 'utf8')).hermes });
  return result;
}

/** Release-builder operation, called only on a newly built resource tree before
 * publication. Refuses an existing PM runtime and verifies the sealed base. */
export async function stageHermesPackageRuntime({ root, releaseLock, artifactCache, onProgress = () => {} }) {
  if (![root, artifactCache].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Supply absolute build output and artifact cache paths.');
  validateReleaseInputs(releaseLock);
  const release = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  await verifyHermesBundle({ root, manifest: release.hermes });
  const pmRoot = join(root, 'hermes/pm-runtime'), site = join(pmRoot, 'site-packages');
  try { await lstat(pmRoot); throw new Error('Preserve the existing package runtime and build a fresh assistant bundle.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packages = releaseLock.packages.filter(row => PM_NAMES.has(normalize(row.name)));
  if (packages.length !== PM_NAMES.size) throw new Error('The release wheel lock needs the independent Hermes package dependencies.');
  const wheels = [];
  for (const row of packages) wheels.push({ ...row, name: normalize(row.name), path: await downloadPinnedArtifact(row, artifactCache) });
  const source = join(root, release.hermes.source), python = join(root, release.hermes.python);
  const scratch = join(resolve(root, '..'), 'pm-build-checks', randomUUID()); await mkdir(scratch, { recursive: true });
  const buildEnv = { HOME: scratch, USERPROFILE: scratch, HERMES_HOME: scratch, LOCALAPPDATA: join(scratch, 'local'), APPDATA: join(scratch, 'roaming'), TEMP: scratch, TMP: scratch, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) buildEnv[key] = process.env[key];
  const plan = JSON.parse(await run(python, ['-I', '-B', '-c', STAGE, source, site, JSON.stringify(wheels)], { env: buildEnv, cwd: scratch }));
  const marker = { python: '../python/python.exe', sitePackages: 'site-packages' };
  await writeFile(join(pmRoot, 'pm-runtime.json'), JSON.stringify(marker, null, 2) + '\n');
  const verification = await verifyHermesPackageRuntime({ root, manifest: release.hermes, scratch });
  const inventoryPath = join(root, release.hermes.inventory), inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const additions = [...plan.files.map(row => ({ ...row, path: 'hermes/pm-runtime/site-packages/' + row.path, kind: 'pm-dependency' }))];
  const markerBytes = await readFile(join(pmRoot, 'pm-runtime.json'));
  additions.push({ path: 'hermes/pm-runtime/pm-runtime.json', size: markerBytes.length, sha256: hash(markerBytes), kind: 'metadata' });
  const paths = new Set(inventory.files.map(row => row.path));
  if (additions.some(row => paths.has(row.path))) throw new Error('The base already contains a package runtime; build from its original verified input.');
  inventory.files.push(...additions); inventory.files.sort((left, right) => left.path.localeCompare(right.path));
  inventory.pmRuntime = { dependencies: plan.packages, verification, source: 'pm/pyproject.toml exact pins and checksum-verified release wheels; independent resident runtime' };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n'); await writeFile(inventoryPath, inventoryBytes);
  release.hermes = { ...release.hermes, inventorySha256: hash(inventoryBytes), pmRuntime: verification };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(release, null, 2) + '\n');
  await verifyHermesBundle({ root, manifest: release.hermes });
  onProgress('Stock Hermes isolated package runtime and CLI passed.');
  return { root, verification, dependencies: plan.packages.map(({ name, version }) => ({ name, version })) };
}

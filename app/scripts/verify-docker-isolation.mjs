import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { APP_ROOT } from '../lib/config.mjs';
import { dockerWorkerSpec, spawnDockerWorker, verifyDockerWorker } from '../lib/docker-worker.mjs';

// Explicit integration diagnostic, never a health check or normal startup.
// Needs the official Alpine image already pulled; no model, account or host data.
const proof = randomUUID(), tag = `nemo-isolation:${proof}`;
const context = join(APP_ROOT, '.work', 'docker-isolation', proof);
const run = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const live = [], volumes = [];
try {
  const base = JSON.parse(run(['image', 'inspect', 'alpine:3.22']))[0].RepoDigests.find(value => value.startsWith('alpine@sha256:'));
  if (!/^alpine@sha256:[a-f0-9]{64}$/.test(base || '')) throw new Error('Pull official alpine:3.22 before this explicit diagnostic.');
  await mkdir(context, { recursive: true });
  await writeFile(join(context, 'probe.sh'), `set -eu
test "$(id -u)" = 10001
test "$HOME" = /var/lib/nemo
test ! -e /var/run/docker.sock
test ! -e /host
if touch /write-outside-profile 2>/dev/null; then exit 71; fi
test -z "$(ip route)"
if [ -f /var/lib/nemo/memory.txt ]; then
  test "$(cat /var/lib/nemo/memory.txt)" = "$NEMO_PROFILE_ID"
else
  printf '%s' "$NEMO_PROFILE_ID" > /var/lib/nemo/memory.txt
fi
test -d "$HERMES_HOME"
printf '{"ok":true,"uid":10001,"privateVolume":true,"network":"none"}\\n'
read -r stop
test "$stop" = stop
`);
  await writeFile(join(context, 'Dockerfile'), `FROM ${base}\nLABEL org.nemo.fixture="${proof}"\nRUN mkdir -p /var/lib/nemo/workspace /var/lib/nemo/hermes && chown -R 10001:10001 /var/lib/nemo\nCOPY probe.sh /opt/nemo-probe.sh\nUSER 10001:10001\nENTRYPOINT ["/bin/sh", "/opt/nemo-probe.sh"]\n`);
  run(['build', '--network=none', '--pull=false', '--tag', tag, context]);
  const imageId = run(['image', 'inspect', tag, '--format', '{{.Id}}']);
  const profiles = [randomUUID(), randomUUID()];
  for (const profileId of profiles) {
    const volume = `nemo-profile-${profileId}`;
    run(['volume', 'create', '--label', `org.nemo.fixture=${proof}`, volume]); volumes.push(volume);
  }
  async function check(profileId) {
    const spec = dockerWorkerSpec({ profileId, classification: 'adult', imageId });
    const child = spawnDockerWorker(spec); live.push({ spec, child });
    let diagnostics = ''; child.stderr.on('data', part => diagnostics += part);
    const closed = once(child, 'close');
    const ready = new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', part => { text += part; if (text.includes('\n')) { try { resolve(JSON.parse(text.slice(0, text.indexOf('\n')))); } catch { reject(new Error('Container probe protocol failed.')); } } });
      child.once('error', reject); child.once('close', code => { if (!text.includes('\n')) reject(new Error(`Container probe exited ${code}: ${diagnostics}`)); });
    });
    const timer = setTimeout(() => { child.stdin.end('stop\n'); }, 20_000);
    try {
      const result = await ready;
      const actual = JSON.parse(run(['container', 'inspect', spec.name]))[0]; verifyDockerWorker(spec, actual);
      if (!result.ok || !result.privateVolume || result.uid !== 10001 || result.network !== 'none') throw new Error('Container probe did not verify all boundaries.');
      child.stdin.end('stop\n');
      const [code] = await closed; if (code !== 0) throw new Error('Container did not stop cleanly.');
    } finally { clearTimeout(timer); }
  }
  await Promise.all(profiles.map(check));
  await check(profiles[0]); // Same person resumes their own private file.
  const result = { ok: true, twoProfiles: true, privateVolumeResume: true, uid: 10001, hostMounts: false, dockerSocket: false, network: 'none', modelCalls: 0, note: 'Sandbox boundary only; this image contains no Hermes engine or tools.' };
  await writeFile(join(context, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const { spec, child } of live) {
    try { const actual = JSON.parse(run(['container', 'inspect', spec.name]))[0]; if (actual.Config.Labels?.['org.nemo.instance'] === spec.instanceId && actual.Config.Labels?.['org.nemo.profile'] === spec.profileId) run(['container', 'rm', '--force', spec.name]); } catch {}
    if (child.exitCode === null) child.kill();
  }
  for (const volume of volumes) { const actual = JSON.parse(run(['volume', 'inspect', volume]))[0]; if (actual.Labels?.['org.nemo.fixture'] !== proof) throw new Error('Refused cleanup of an unrelated volume.'); run(['volume', 'rm', volume]); }
  try { const actual = JSON.parse(run(['image', 'inspect', tag]))[0]; if (actual.Config.Labels?.['org.nemo.fixture'] === proof) run(['image', 'rm', tag]); } catch {}
}

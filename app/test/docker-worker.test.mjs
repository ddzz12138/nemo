import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dockerWorkerSpec, spawnDockerWorker, verifyDockerWorker } from '../lib/docker-worker.mjs';

const imageId = 'sha256:' + '1'.repeat(64);
function inspected(spec) { return { Name: '/' + spec.name, Image: spec.imageId, Config: { User: '10001:10001', Labels: { 'org.nemo.managed': 'worker', 'org.nemo.profile': spec.profileId, 'org.nemo.instance': spec.instanceId } }, HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', IpcMode: 'private', PidMode: '', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 256, Memory: 2 * 1024 ** 3, NanoCpus: 2_000_000_000 }, Mounts: [{ Type: 'volume', Name: spec.volume, Destination: '/var/lib/nemo', RW: true }] }; }

test('adult workers receive one private volume and no host, network, command or credential overrides', () => {
  const first = dockerWorkerSpec({ profileId: randomUUID(), classification: 'adult', imageId });
  const other = dockerWorkerSpec({ profileId: randomUUID(), classification: 'adult', imageId });
  assert.notEqual(first.volume, other.volume); assert.ok(first.args.includes('--network=none')); assert.equal(first.args.at(-1), imageId);
  assert.equal(first.args.some(arg => /docker\.sock|type=bind|--privileged|--network=host|API_KEY|TOKEN/.test(arg)), false);
  for (const classification of ['child', 'unclassified', undefined]) assert.throws(() => dockerWorkerSpec({ profileId: first.profileId, classification, imageId }), /classified adult/);
  assert.throws(() => dockerWorkerSpec({ profileId: '../other', classification: 'adult', imageId }));
  assert.throws(() => dockerWorkerSpec({ profileId: first.profileId, classification: 'adult', imageId: 'untrusted:latest' }), /digest/);
  assert.equal(verifyDockerWorker(first, inspected(first)), true);
  const modifications = [actual => { actual.Mounts[0].Name = other.volume; }, actual => { actual.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock' }); }, actual => { actual.HostConfig.NetworkMode = 'host'; }, actual => { actual.HostConfig.Privileged = true; }, actual => { actual.Config.Labels['org.nemo.profile'] = other.profileId; }, actual => { actual.HostConfig.CapAdd = ['SYS_ADMIN']; }];
  for (const change of modifications) { const actual = inspected(first); change(actual); assert.throws(() => verifyDockerWorker(first, actual)); }
  let args;
  spawnDockerWorker({ ...first, args: ['run', '--privileged', 'attacker'] }, { spawn: (_command, value, options) => { args = value; assert.equal(options.shell, false); } });
  assert.deepEqual(args, first.args);
});

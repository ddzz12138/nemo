import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function dockerWorkerSpec({ profileId, classification, imageId, instanceId = randomUUID() }) {
  if (!UUID.test(profileId || '') || !UUID.test(instanceId || '') || !['adult', 'owner'].includes(classification)) throw new Error('An explicitly classified adult profile is required for a computer worker.');
  if (!DIGEST.test(imageId || '')) throw new Error('A verified local image digest is required.');
  const name = `nemo-worker-${profileId}-${instanceId}`;
  const volume = `nemo-profile-${profileId}`;
  // No caller-controlled command, environment, bind mount, network or Docker
  // endpoint. Networkless is the initial policy; a broker/egress relay must be
  // independently verified before connected/full-tool workers become Ready.
  const args = ['run', '--rm', '--interactive', '--pull=never', '--name', name,
    '--label', 'org.nemo.managed=worker', '--label', `org.nemo.profile=${profileId}`,
    '--label', `org.nemo.instance=${instanceId}`, '--network=none', '--ipc=private',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only',
    '--user=10001:10001', '--pids-limit=256', '--memory=2g', '--cpus=2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=134217728',
    '--mount', `type=volume,src=${volume},dst=/var/lib/nemo`,
    '--workdir=/var/lib/nemo/workspace', '--env', 'HOME=/var/lib/nemo',
    '--env', 'HERMES_HOME=/var/lib/nemo/hermes', '--env', `NEMO_PROFILE_ID=${profileId}`,
    imageId];
  return Object.freeze({ profileId, instanceId, name, volume, imageId, args: Object.freeze(args) });
}

export function verifyDockerWorker(spec, actual) {
  const labels = actual?.Config?.Labels || {}, host = actual?.HostConfig || {};
  const mounts = actual?.Mounts;
  if (actual?.Name !== '/' + spec.name || actual.Image !== spec.imageId || labels['org.nemo.managed'] !== 'worker' || labels['org.nemo.profile'] !== spec.profileId || labels['org.nemo.instance'] !== spec.instanceId) throw new Error('Worker container identity changed.');
  if (host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode !== 'none' || actual.Config.User !== '10001:10001' || !['private', ''].includes(host.IpcMode) || host.PidMode || host.PortBindings && Object.keys(host.PortBindings).length || host.CapAdd?.length) throw new Error('Worker isolation policy changed.');
  if (!host.CapDrop?.includes('ALL') || !host.SecurityOpt?.some(value => ['no-new-privileges:true', 'no-new-privileges'].includes(value)) || host.PidsLimit !== 256 || host.Memory !== 2 * 1024 ** 3 || host.NanoCpus !== 2_000_000_000) throw new Error('Worker resource policy changed.');
  if (!Array.isArray(mounts) || mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== spec.volume || mounts[0].Destination !== '/var/lib/nemo' || mounts[0].RW !== true) throw new Error('Worker mounts crossed the profile boundary.');
  if (host.Binds?.length || host.Devices?.length || host.DeviceRequests?.length || Object.keys(host.Tmpfs || {}).some(path => path !== '/tmp')) throw new Error('Worker gained a host binding or device.');
  return true;
}

/** A narrow lifecycle wrapper; readiness is not implied by spawning. The
 * supervisor must inspect/verify the container before admitting any prompt. */
export function spawnDockerWorker(spec, { spawn = nodeSpawn } = {}) {
  if (!spec || !UUID.test(spec.profileId || '') || spec.name !== `nemo-worker-${spec.profileId}-${spec.instanceId}`) throw new Error('A trusted worker specification is required.');
  // Recompute rather than trusting a mutable argument list from another layer.
  const checked = dockerWorkerSpec({ ...spec, classification: 'adult' });
  return spawn('docker', checked.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

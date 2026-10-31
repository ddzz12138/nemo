import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';

export function discoverHermes({ env = process.env, platform = process.platform, exists = existsSync, home = homedir() } = {}) {
  const legacy = join(env.USERPROFILE || home, 'hermes-startup-data');
  const candidates = [env.NEMO_HERMES_LAUNCHER, ...(platform === 'win32' ? [join(legacy,'bin','hermes.cmd')] : []),
    ...(env.PATH || '').split(delimiter).filter(Boolean).map(folder => join(folder, platform === 'win32' ? 'hermes.cmd' : 'hermes'))];
  const launcher = candidates.find(path => path && isAbsolute(path) && exists(path)) || '';
  const hermesHome = env.NEMO_HERMES_HOME || (platform === 'win32' && exists(legacy) ? legacy : join(home,'.hermes'));
  return { launcher, hermesHome };
}

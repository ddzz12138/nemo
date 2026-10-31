import { readFile } from 'node:fs/promises';
import { APP_ROOT } from '../lib/config.mjs';
import { verifyPublicSource } from '../lib/source-publication.mjs';
import { execFileSync } from 'node:child_process';
const paths = JSON.parse(await readFile(new URL('../source-manifest.json', import.meta.url), 'utf8'));
if (process.argv.includes('--tracked')) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: APP_ROOT, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean).sort();
  if (JSON.stringify(tracked) !== JSON.stringify([...paths].sort())) throw new Error('Tracked application files must exactly match the reviewed source inventory.');
}
console.log(JSON.stringify(await verifyPublicSource(APP_ROOT, paths)));

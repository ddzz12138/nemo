import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const forbiddenDirectory = /^(?:node_modules|__pycache__|out|coordination|research|website-design|\.nemo|\.work|\.git|\.cache|\.cursor|\.codex)$/i;
const forbiddenFile = /(?:\.(?:dpapi|db|sqlite3?|log|pem|key|pfx|p12|exe|dll|nupkg|tgz|woff2?|ttf|jpg|jpeg|png)$|^(?:\.env(?:\..*)?|auth\.json|nemo\.json|state\.json|profiles\.json|gmail-tokens\.json|config\.json)$)/i;
const unsafeContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{25,}/,
  /\bsk-[A-Za-z0-9]{25,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+(?:\\{1,2}|\/)/i,
  /\b(?:[a-z0-9-]+\.)*tail[a-f0-9]{6}\.ts\.net\b/i,
];

/** Check explicitly inventoried source, never traverse the developer's data. */
export async function verifyPublicSource(root, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(x => typeof x !== 'string')) throw new Error('A nonempty source inventory is required.');
  const unique = new Set();
  for (const file of paths) {
    if (!file || file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) throw new Error('Invalid source inventory path.');
    const parts = file.split('/');
    if (parts.some(x => !x || x === '.' || x === '..' || forbiddenDirectory.test(x)) || forbiddenFile.test(parts.at(-1))) throw new Error(`Excluded source path: ${file}`);
    if (unique.has(file)) throw new Error(`Duplicate source path: ${file}`);
    unique.add(file);
    for (let i = 1; i <= parts.length; i++) {
      const info = await lstat(join(root, ...parts.slice(0, i)));
      if (info.isSymbolicLink() || (i === parts.length ? !info.isFile() : !info.isDirectory())) throw new Error(`Source must contain regular files and directories: ${file}`);
    }
    const bytes = await readFile(join(root, file));
    if (bytes.includes(0)) throw new Error(`Unexpected binary source: ${file}`);
    const text = bytes.toString('utf8');
    if (unsafeContent.some(pattern => pattern.test(text))) throw new Error(`Private content found in source: ${file}`);
    if (file === 'desktop/google-oauth.json') {
      const config = JSON.parse(text);
      if (config.clientId || config.clientSecret || config.client_secret) throw new Error('Public source must not select the maintainer Google account configuration.');
    }
  }
  return { verified: true, files: unique.size };
}

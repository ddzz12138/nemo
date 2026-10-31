'use strict';
const { lstat, readdir, realpath, rmdir } = require('node:fs/promises');
const { isAbsolute, join, relative } = require('node:path');
const allowedFiles = new Set(['package.json','package-lock.json','server.mjs','mcp-server.mjs','LICENSE','THIRD_PARTY_NOTICES.md']);
const allowedTrees = new Set(['lib','public','bin','desktop','node_modules']);
// Electron's copier sees the entire checkout. Include only runtime source and
// production dependencies; profile data and coordination never enter a build.
function ignore(file) {
  const parts = file.replaceAll('\\', '/').split('/').filter(Boolean);
  if (!parts.length) return false;
  if (!allowedFiles.has(parts[0]) && !allowedTrees.has(parts[0])) return true;
  // Only the compiled interface ships. Build dependencies and upstream references do not.
  if (parts[0] === 'desktop' && parts[1] === 'interface') return true;
  if (parts[0] === 'lib' && parts[1]?.startsWith('remote-cloud')) return true;
  if (parts[0] === 'node_modules') return false;
  return parts.some(part => part.startsWith('.') || /\.(?:dpapi|db|sqlite3?|log|pem|key)$/i.test(part) || ['profiles.json','nemo.json','auth.json','state.json','config.json','manifest.json'].includes(part));
}
// NuGet adds an unlisted `_._` file to every empty directory. Remove empty
// directories from the copied payload before Squirrel creates its archive, so
// installation preserves the sealed Hermes inventory byte for byte.
async function pruneEmptyHermesDirectories(resourcesPath) {
  if (!isAbsolute(resourcesPath)) throw new Error('Packaged resources must have an absolute location.');
  const resources = await realpath(resourcesPath);
  const root = join(resources, 'desktop-runtime', 'hermes');
  let info;
  try { info = await lstat(root); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The packaged assistant must be a regular directory.');
  const resolved = await realpath(root), contained = relative(resources, resolved);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw new Error('The packaged assistant escaped its resources.');
  let removed = 0;
  async function visit(directory, keep = false) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('The packaged assistant contains a linked folder.');
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
    if (!keep && !(await readdir(directory)).length) { await rmdir(directory); removed++; }
  }
  await visit(root, true);
  return removed;
}
module.exports = { ignore, pruneEmptyHermesDirectories };

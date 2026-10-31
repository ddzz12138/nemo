import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';
const directory = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(directory, 'src/main.jsx')],
  outfile: resolve(directory, '../../public/desktop-ui.js'),
  bundle: true, minify: true, sourcemap: false, target: ['chrome138'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof', metafile: false, logLevel: 'info',
});
for (const name of ['react', 'react-dom']) await copyFile(resolve(directory, 'node_modules', name, 'LICENSE'), resolve(directory, '../../public/vendor', name + '-LICENSE.txt'));

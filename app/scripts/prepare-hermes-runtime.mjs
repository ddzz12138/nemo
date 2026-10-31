import { parseArgs } from 'node:util';
import { prepareHermesBundle } from '../lib/hermes-bundle.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, python: { type: 'string' }, 'site-packages': { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.source || !values.python || !values['site-packages'] || !values.out) {
  console.error('Release operator usage: node scripts/prepare-hermes-runtime.mjs --source <absolute tracked Hermes checkout> --python <absolute standalone Python folder> --site-packages <absolute wheel dependency folder> --out <absolute output folder>');
  process.exitCode = 1;
} else {
  try {
    const result = await prepareHermesBundle({ sourceRoot: values.source, pythonRoot: values.python, sitePackages: values['site-packages'], out: values.out, onProgress: message => console.log(message) });
    console.log(`Prepared verified relocatable Hermes: ${result.files} files, ${result.dependencies} dependency distributions. No personal Hermes data was copied.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

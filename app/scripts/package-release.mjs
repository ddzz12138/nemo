import { join } from 'node:path';
import { APP_ROOT } from '../lib/config.mjs';
import { packageRelease } from '../lib/release.mjs';
console.log(JSON.stringify(await packageRelease({root:APP_ROOT,outDir:join(APP_ROOT,'.work','releases')}),null,2));

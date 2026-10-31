import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT } from '../lib/config.mjs';
const files=['server.mjs','mcp-server.mjs','remote-service.mjs','forge.config.mjs'];
for(const directory of ['lib','public','bin','scripts','desktop'])for(const file of await readdir(join(APP_ROOT,directory)))if(/\.(?:mjs|cjs|js)$/.test(file))files.push(join(directory,file));
for(const file of files){const result=spawnSync(process.execPath,['--check',join(APP_ROOT,file)],{stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(1);}
console.log(`Syntax checked ${files.length} JavaScript files.`);

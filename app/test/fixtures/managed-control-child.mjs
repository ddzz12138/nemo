import {createProcessControl} from '../../lib/managed-process.mjs';
await createProcessControl({dataDir:process.argv[2],onStop:()=>process.exit(0)});
process.stdout.write('READY\n');process.stdin.resume();

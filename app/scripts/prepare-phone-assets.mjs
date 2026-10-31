import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROOT } from '../lib/config.mjs';
const targets=[['@trystero-p2p/nostr','nostr','0.26.0'],['@trystero-p2p/core','core','0.26.0'],['@noble/secp256k1','secp256k1',null]];
for(const[name,directory,expected]of targets){
  const source=join(APP_ROOT,'node_modules',name),pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  if(expected&&pkg.version!==expected)throw new Error('Unexpected phone transport dependency version. Run npm ci.');
  const destination=join(APP_ROOT,'public','vendor','phone-link',directory);await mkdir(destination,{recursive:true});
  const dist=directory==='secp256k1'?source:join(source,'dist');
  for(const file of await readdir(dist))if(/\.(mjs|js)$/.test(file)){
    let code=await readFile(join(dist,file),'utf8');
    code=code.replaceAll('"@trystero-p2p/core"','"../core/index.mjs"').replaceAll("'@trystero-p2p/core'","'../core/index.mjs'").replaceAll('"@noble/secp256k1"','"../secp256k1/index.js"').replaceAll("'@noble/secp256k1'","'../secp256k1/index.js'");
    await writeFile(join(destination,file),code);
  }
  await writeFile(join(destination,'LICENSE'),await readFile(join(source,'LICENSE')));
}
console.log('Prepared pinned, locally served phone transport modules. No CDN runtime dependency.');

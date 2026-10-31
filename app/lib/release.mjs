import { readdir, readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT_FILES = new Set(['package.json','package-lock.json','server.mjs','mcp-server.mjs','remote-service.mjs','LICENSE','README.md','QUICKSTART.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md']);
const TREES = ['lib','public','bin','docs','desktop'];
export async function releaseEntries(root) {
  const result=[];
  async function add(path) {
    // Frontend dependencies and Python bytecode are generated inputs, never CLI
    // source. Exclude these known directories before traversal; retain private
    // file rejection everywhere else, including alongside frontend source.
    const sourcePath=relative(root,path).replaceAll('\\','/');
    if(sourcePath==='desktop/interface/node_modules'||sourcePath.split('/').at(-1)==='__pycache__') {
      const info=await lstat(path);
      if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Frontend dependencies must be a regular generated directory.');
      return;
    }
    const info=await lstat(path); if(info.isSymbolicLink())throw new Error('Release inputs cannot contain symlinks.');
    if(info.isDirectory()) { for(const item of await readdir(path)) { if(item.startsWith('.') || /(?:\.log$|\.db$|\.sqlite(?:3)?$|\.dpapi$|\.pem$|\.key$)/i.test(item) || ['profiles.json','state.json','nemo.json','auth.json','config.json','gmail-tokens.json'].includes(item))throw new Error('Private or generated data found inside a release source directory.'); await add(join(path,item)); } }
    else if(info.isFile())result.push({name:relative(root,path).replaceAll('\\','/'),data:await readFile(path)});
  }
  // Every declared package input is required. A partial checkout must fail
  // packaging rather than silently producing an unstartable release.
  for(const name of [...ROOT_FILES,...TREES]) await add(join(root,name));
  // Only the redistributable notice, not private reference screenshots.
  await add(join(root,'references','hermes-memory-LICENSE.txt'));
  for(const script of ['check-syntax.mjs','package-release.mjs','connect-gmail.mjs','setup-gmail-web.mjs','prepare-phone-assets.mjs','export-phone-app.mjs'])await add(join(root,'scripts',script));
  await add(join(root,'deploy','phone-relay','coturn.conf.example'));
  return result.sort((a,b)=>a.name.localeCompare(b.name));
}

export function tarGzip(entries) {
  const output=[];
  for(const {name,data} of entries) {
    const path=`package/${name}`;
    if(Buffer.byteLength(path)>100 || /(?:^|\/)\.\.(?:\/|$)/.test(path))throw new Error('Invalid release path.');
    const header=Buffer.alloc(512);
    header.write(path,0,100);header.write(name.startsWith('bin/')?'0000755\0':'0000644\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8);
    header.write(data.length.toString(8).padStart(11,'0')+'\0',124,12);header.write('00000000000\0',136,12);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257,6);header.write('00',263,2);
    const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    output.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  output.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(output),{level:9});
}

export async function packageRelease({root,outDir}) {
  const entries=await releaseEntries(root);const metadata=JSON.parse(entries.find(entry=>entry.name==='package.json').data);
  if(!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(metadata.version))throw new Error('Invalid release version.');
  const archive=tarGzip(entries);await mkdir(outDir,{recursive:true});
  const name=`nemo-${metadata.version}.tgz`;await writeFile(join(outDir,name),archive);
  const hash=createHash('sha256').update(archive).digest('hex');
  await writeFile(join(outDir,name+'.sha256'),`${hash}  ${name}\n`);
  await writeFile(join(outDir,'manifest.json'),JSON.stringify({version:metadata.version,files:entries.map(({name,data})=>({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}))},null,2));
  return {name,sha256:hash,files:entries.length};
}

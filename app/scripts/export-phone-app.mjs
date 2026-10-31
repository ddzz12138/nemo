import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from '../lib/config.mjs';

/** Static UI only. No profile, database, credential, log or server file is copied. */
export async function exportPhoneApp(destination) {
  const out=resolve(destination),source=join(APP_ROOT,'public');
  if(out===APP_ROOT||out===source||out.startsWith(source+sep))throw new Error('Choose a new export directory outside public/.');
  await mkdir(dirname(out),{recursive:true});await mkdir(out);
  async function vendor(from,to){
    await mkdir(to,{recursive:true});
    for(const file of await readdir(from,{withFileTypes:true})){
      if(file.isSymbolicLink())throw new Error('Phone exports must not contain symbolic links.');
      if(file.isDirectory())await vendor(join(from,file.name),join(to,file.name));
      else if(/\.(js|mjs|css|svg|png)$/.test(file.name)||/^(LICENSE|COPYING)(?:[.-].*)?$/i.test(file.name)||/-LICENSE\.txt$/i.test(file.name))await cp(join(from,file.name),join(to,file.name),{errorOnExist:true,force:false});
    }
  }
  for(const file of await readdir(source,{withFileTypes:true})){
    if(file.name.startsWith('host-setup'))continue;
    if(file.isSymbolicLink())throw new Error('Phone exports must not contain symbolic links.');
    if(file.isDirectory()&&file.name==='vendor')await vendor(join(source,file.name),join(out,file.name));
    else if(file.isFile()&&/\.(html|js|mjs|css|svg|png|webmanifest)$/.test(file.name))await cp(join(source,file.name),join(out,file.name),{errorOnExist:true,force:false});
  }
  await writeFile(join(out,'phone-app-config.js'),'window.NEMO_PHONE_APP = true;\n');
  await writeFile(join(out,'phone-app.json'),JSON.stringify({service:'nemo-phone-app',protocol:1,static:true})+'\n');
  await writeFile(join(out,'_headers'),`/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-cache\n`);
  await cp(join(APP_ROOT,'LICENSE'),join(out,'LICENSE'));
  await writeFile(join(out,'DEPLOYMENT.txt'),'Serve this directory at the root of an HTTPS origin. Configure that exact origin in Nemo > Phone access on the host. This export contains UI code only. No service has been provisioned, and no paid relay is enabled. Preserve the included third-party licences.\n');
  return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const out=process.argv[2]||join(APP_ROOT,'.work','phone-app');console.log('Exported static phone app: '+await exportPhoneApp(out));}

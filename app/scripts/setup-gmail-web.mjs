import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGmailWebClient } from '../lib/gmail.mjs';
import { loadConfig } from '../lib/config.mjs';

export async function main(args, { config = loadConfig, install = installGmailWebClient, output = console.log, errorOutput = console.error } = {}) {
  if (args.length !== 2 || args[0] !== '--client') {
    output('Usage: node scripts/setup-gmail-web.mjs --client "C:/path/web-client.json"');
    output('Import a Google Web application OAuth client for private phone sign-in. Existing Gmail grants are preserved.');
    return args.includes('--help') ? 0 : 1;
  }
  try {
    const current = await config();
    const result = await install({ dataDir: current.dataDir, clientPath: resolve(args[1]), publicOrigin: current.publicOrigin });
    output('Google Web client imported with Windows user protection. No account was switched.');
    for (const uri of result.redirectUris) output(`Registered return address: ${uri}`);
    return 0;
  } catch (error) { errorOutput(error.message || 'The Google Web client could not be imported.'); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installGmailDesktopClient, GmailError } from '../lib/gmail.mjs';
import { loadConfig } from '../lib/config.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Connect read-only Gmail from your signed-in Nemo profile: Settings → Connections → Gmail.\n\nOptional shared Desktop application configuration:\n  node scripts/connect-gmail.mjs --client "path/to/desktop-client.json"\n\nPhone sign-in uses a Web application client imported with nemo gmail. Account authorization always happens inside your profile.');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--client' || !args[1] || args[1].startsWith('--'))) throw new GmailError('GMAIL_ARGUMENTS', 'Use: node scripts/connect-gmail.mjs --client "C:\\path\\desktop-client.json"');
  const { dataDir } = await loadConfig();
  if (args.length) await installGmailDesktopClient({ dataDir, clientPath: resolve(args[1]) });
  if (args.length) console.log('Shared Desktop application configuration imported. No account was connected or switched.');
  console.log('Open Nemo on your own signed-in device, then Settings → Connections → Gmail. Each profile connects its own read-only account there.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof GmailError ? error.message : 'Gmail setup could not complete. Check the Desktop OAuth client file and run this command from your normal Windows account.');
    process.exitCode = 1;
  });
}

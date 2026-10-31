import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publisherClient } from '../lib/gmail-publisher.mjs';

// Developer-only packaging helper. The selected Desktop client JSON stays
// private; only its public client ID enters the source/distribution.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--client') throw new Error('Use --client with your explicitly selected Google Desktop app OAuth JSON.');
if ((await stat(args[1])).size > 65_536) throw new Error('The selected Google client file is too large.');
const source = JSON.parse(await readFile(args[1], 'utf8'));
const value = { version: 1, clientId: source.installed?.client_id };
publisherClient(value);
await writeFile(fileURLToPath(new URL('../desktop/google-oauth.json', import.meta.url)), JSON.stringify(value, null, 2) + '\n');
console.log('Saved the public Google Desktop client ID. No client secret or account grant was copied.');

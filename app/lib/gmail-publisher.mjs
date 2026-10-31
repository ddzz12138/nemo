import { readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function publisherClient(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'clientId'].includes(key)) || !/^[A-Za-z0-9._-]{1,240}\.apps\.googleusercontent\.com$/.test(value.clientId || '')) throw new Error('Nemo’s public Google client configuration is invalid.');
  return { installed: { client_id: value.clientId } };
}

/** The packaged file contains only a public desktop client ID. Never overwrite
 * operator configuration, discover grants, or import an account's tokens. */
export async function ensureGmailPublisherClient({ dataDir, publisherPath }) {
  let text;
  try { text = await readFile(publisherPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { available: false }; throw error; }
  if (text.length > 2048) throw new Error('Nemo’s public Google client configuration is invalid.');
  const config = publisherClient(JSON.parse(text));
  await mkdir(dataDir, { recursive: true });
  const temporary = join(dataDir, `google-client.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Publish a complete file without ever replacing an operator's client.
    await link(temporary, join(dataDir, 'google-client.json'));
  }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary).catch(() => {}); }
  return { available: true };
}

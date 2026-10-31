import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function keychainCommand(args, input = '') {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('/usr/bin/security', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); }, 15_000);
    child.stdout.on('data', value => { stdout += value; if (stdout.length > 1_500_000) { stopped = true; child.kill(); } });
    child.stderr.on('data', value => { stderr += value; if (stderr.length > 16_384) { stopped = true; child.kill(); } });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('macOS Keychain is unavailable.')); });
    child.on('close', code => { clearTimeout(timer); if (stopped) reject(new Error('macOS Keychain did not respond.')); else resolveCommand({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const keychainWrites = new Map();
async function serializedKeychainWrite(path, action) {
  const previous = keychainWrites.get(path) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  keychainWrites.set(path, next);
  try { return await next; } finally { if (keychainWrites.get(path) === next) keychainWrites.delete(path); }
}

export function createMacKeychainStore({ dataDir, name, maximum, command = keychainCommand }) {
  const path = join(dataDir, name);
  const account = createHash('sha256').update(`${resolve(dataDir)}\0${name}`).digest('hex');
  const legacyIdentity = ['-a', account, '-s', `org.nemo.${name}`];
  const service = `org.nemo.key.${name}`;
  const identity = ['-a', account, '-s', service];
  const aad = Buffer.from(`nemo-keychain-v2:${account}`, 'utf8');
  const readValue = async (fields, bound) => {
    const result = await command(['find-generic-password', ...fields, '-w']);
    if (result.code === 44) return null;
    const value = result.stdout.trim();
    if (result.code !== 0 || value.length > bound || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Nemo could not unlock macOS Keychain.');
    return value;
  };
  const readKey = async () => {
    const value = await readValue(identity, 44);
    if (value === null) return null;
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Nemo could not unlock macOS Keychain.');
    return key;
  };
  const getKey = async () => {
    let key = await readKey();
    if (key) return key;
    const proposed = randomBytes(32).toString('base64');
    // Store only a short encryption key in Keychain. security -i has a bounded
    // line reader; caches must never be passed through it. No -U: a racing
    // process cannot replace the key protecting an already-written record.
    await command(['-i'], `add-generic-password -a ${account} -s ${service} -w ${proposed}\n`);
    key = await readKey();
    if (!key) throw new Error('Nemo could not save this connection in macOS Keychain.');
    return key;
  };
  const removeValue = async fields => {
    const result = await command(['delete-generic-password', ...fields]);
    if (![0,44].includes(result.code)) throw new Error('Nemo could not remove this connection from macOS Keychain.');
  };
  return {
    async load() {
      let marker;
      try { marker = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (marker.length > maximum * 2 + 8192) throw new Error('Protected connection data is too large.');
      if (marker.startsWith(`nemo-keychain-v1:${account}:`)) {
        const value = await readValue(legacyIdentity, maximum * 2);
        if (!value) throw new Error('This connection is missing from macOS Keychain. Reconnect the account.');
        try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); }
        catch { throw new Error('Nemo could not unlock macOS Keychain.'); }
      }
      let envelope;
      try { envelope = JSON.parse(marker); } catch {}
      if (envelope?.version !== 2 || envelope.account !== account) throw new Error('Reconnect this account on this Mac; credentials from another operating system cannot be unlocked.');
      const key = await readKey();
      if (!key) throw new Error('This connection is missing from macOS Keychain. Reconnect the account.');
      try {
        for (const field of ['iv', 'tag', 'ciphertext']) if (typeof envelope[field] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope[field])) throw new Error();
        const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
        const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
        if (bytes.length > maximum) throw new Error();
        return JSON.parse(bytes.toString('utf8'));
      } catch { throw new Error('Nemo could not unlock this protected connection.'); }
    },
    async save(record) {
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      if (bytes.length > maximum) throw new Error('Protected connection data is too large.');
      await serializedKeychainWrite(path, async () => {
        const key = await getKey(), iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        const envelope = JSON.stringify({ version: 2, account, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
        await mkdir(dataDir, { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, envelope, { mode: 0o600 }); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => {}); }
        await removeValue(legacyIdentity);
      });
    },
    async remove() {
      await serializedKeychainWrite(path, async () => {
        await removeValue(identity); await removeValue(legacyIdentity);
        await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      });
    },
  };
}

// Fixed helper code only. Tokens travel over stdin, never command arguments,
// environment variables, logs, or PowerShell's command parser.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String([string]$inputData.value)
  if ($inputData.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($inputData.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

function dpapi(operation, bytes, maximum = 131_072) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows user protection is required for Gmail credentials.'));
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) return Promise.reject(new Error('Gmail credential data is invalid.'));
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 10_000);
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > maximum * 2 + 8192) { failed = true; child.kill(); } });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Windows could not protect or unlock Gmail credentials.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output) || output.length % 4 !== 0) return reject(new Error('Windows could not protect or unlock Gmail credentials.'));
      resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.end(JSON.stringify({ operation, value: bytes.toString('base64') }));
  });
}

/** A single-record store, confined to dataDir/gmail-tokens.dpapi.
 * Records are protected for this Windows user and machine with DPAPI CurrentUser.
 * Tests inject {load, save, remove} instead; there is no plaintext fallback.
 */
export function createSecretStore({ dataDir, name = 'gmail-tokens.dpapi', platform = process.platform, keychainCommand: command } = {}) {
  if (!['gmail-tokens.dpapi', 'google-web-client.dpapi', 'gmail-sync.dpapi', 'remote-access.dpapi', 'assistant-provider.dpapi', 'phone-link.dpapi'].includes(name)) throw new Error('Unknown protected connection store.');
  const maximum = ['gmail-sync.dpapi', 'phone-link.dpapi'].includes(name) ? 1_048_576 : 131_072;
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A Gmail data directory is required.');
  if (platform === 'darwin') return createMacKeychainStore({ dataDir, name, maximum, command });
  const path = join(dataDir, name);
  const store = {
    async load() {
      let ciphertext;
      try { ciphertext = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Gmail credentials could not be read.'); }
      if (ciphertext.length > maximum * 2 + 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext.trim())) throw new Error('Gmail credentials could not be unlocked.');
      try { return JSON.parse((await dpapi('unprotect', Buffer.from(ciphertext.trim(), 'base64'), maximum)).toString('utf8')); }
      catch { throw new Error('Gmail credentials could not be unlocked for this Windows user. Reconnect Gmail on the PC.'); }
    },
    async save(record) {
      let encoded;
      try { encoded = (await dpapi('protect', Buffer.from(JSON.stringify(record), 'utf8'), maximum)).toString('base64'); }
      catch { throw new Error('Gmail credentials could not be protected for this Windows user.'); }
      await mkdir(dataDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, encoded, { mode: 0o600 }); await rename(temporary, path); }
      catch { throw new Error('Protected Gmail credentials could not be saved.'); }
      finally { await unlink(temporary).catch(() => {}); }
    },
    async remove() {
      try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Local Gmail credentials could not be removed.'); }
    },
  };
  if (name === 'remote-access.dpapi') return {
    async load() { try { return await store.load(); } catch { throw new Error('Nemo could not unlock its protected phone connection. Open Nemo on the computer where it was set up.'); } },
    async save(record) { try { await store.save(record); } catch { throw new Error('Nemo could not safely save its phone connection. Please try again on this computer.'); } },
    async remove() { try { await store.remove(); } catch { throw new Error('Nemo could not remove its protected phone connection. Please try again.'); } },
  };
  return store;
}

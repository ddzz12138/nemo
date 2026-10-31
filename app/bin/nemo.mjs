#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, saveConfig, APP_ROOT } from '../lib/config.mjs';
import { createProfileStore } from '../lib/profile-store.mjs';
import { installGmailWebClient } from '../lib/gmail.mjs';
import { createProcessControl, stopManagedProcess } from '../lib/managed-process.mjs';
import { discoverHermes } from '../lib/hermes-runtime.mjs';
import { configureNativePreview } from '../lib/native-chat.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const help = 'Nemo — Hermes, for your family\n\n  nemo setup       Guided local setup\n  nemo doctor      Read-only setup checks\n  nemo start       Run in this terminal\n  nemo stop        Stop this installation’s managed process\n  nemo invite      Create a private invitation for your owner profile\n  nemo gmail FILE  Import your Google Web OAuth client locally\n  nemo preview off Disable the optional native chat preview\n\nRequires a ChatGPT subscription. Relevant context is sent to ChatGPT for replies. No credentials belong in chat.\n';
async function main() {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  const config = await loadConfig();
  if (command === 'assistant' && args.length === 1 && args[0] === 'local') {
    throw new Error('This version requires a ChatGPT subscription. Open Nemo Settings to connect. Local models are not supported.');
  }
  if (command === 'host-setup' && !args.length) {
    const { startDesktopHost } = await import('../lib/desktop-host.mjs');
    const host = await startDesktopHost({ dataDir: config.dataDir, openExternal: async url => {
      const { spawn } = await import('node:child_process');
      if (process.platform === 'win32') {
        // Fixed PowerShell program, URL passed over stdin; never shell-interpolated.
        const script = "$ErrorActionPreference='Stop'; $nemoAddress=[Console]::In.ReadToEnd(); Start-Process -FilePath $nemoAddress -WindowStyle Hidden";
        await new Promise((resolve, reject) => { const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { stdio:['pipe','ignore','ignore'], windowsHide:true }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Sign-in could not open.'))); child.stdin.end(url); });
      } else await new Promise((resolve, reject) => { const child = spawn('/usr/bin/open', [url], { shell:false, stdio:'ignore' }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Sign-in could not open.'))); });
    } });
    console.log(`Open this private setup link on this computer: ${host.bootstrapUrl}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void host.close().then(() => process.exit(0)); });
    return;
  }
  if(command==='preview'){
    if(args.length===1&&args[0]==='off')await configureNativePreview({dataDir:config.dataDir,enabled:false});
    else if(args[0]==='enable')throw new Error('The alternative-provider preview is not available in this release. Use your ChatGPT subscription in Nemo Settings.');
    else throw new Error('Use nemo preview off. Connect your ChatGPT subscription in Nemo Settings.');
    console.log('Preview setting saved. Restart this Nemo installation to apply it. Main chat, saved Memory and connections are preserved. Read tools require each profile’s saved consent.');return;
  }
  if (command === 'doctor') {
    const discovered = discoverHermes();
    const checks = [{ name: 'Host platform', ok: ['win32','darwin'].includes(process.platform) }, { name: 'Node.js 22+', ok: Number(process.versions.node.split('.')[0]) >= 22 },
      { name: 'HTTPS phone address', ok: config.publicOrigin.startsWith('https://') },
      { name: 'Hermes runtime located (compatibility check still required)', ok: !!(config.hermesPython && config.hermesSource) || !!(config.hermesLauncher || discovered.launcher) },
      { name: 'Private profile registry', ok: existsSync(join(config.dataDir, 'profiles.json')) }];
    console.log(JSON.stringify({ platform: process.platform, runtime: config.runtime, dataDir: config.dataDir, checks, note: 'Checks do not invoke models, inspect messages or read account credentials. Native workers and advanced tools still require setup and verification.' }, null, 2));
    return;
  }
  if (command === 'setup') {
    if (!stdin.isTTY) throw new Error('Run setup in your own interactive terminal.');
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const publicOrigin = await prompt.question(`Private HTTPS phone address [${config.publicOrigin || 'configure later'}]: `);
      const hermesLauncher = await prompt.question(`Absolute Hermes launcher path [${config.hermesLauncher || 'configure later'}]: `);
      const hermesHome = await prompt.question(`Hermes home directory [${config.hermesHome || 'default'}]: `);
      const hermesPython = await prompt.question(`Optional Hermes environment Python path [${config.hermesPython || 'use launcher'}]: `);
      const hermesSource = await prompt.question(`Optional compatible Hermes source directory [${config.hermesSource || 'use launcher'}]: `);
      await saveConfig(config.dataDir, { publicOrigin: publicOrigin.trim() || config.publicOrigin, hermesLauncher: hermesLauncher.trim() || config.hermesLauncher, hermesHome: hermesHome.trim() || config.hermesHome, hermesPython: hermesPython.trim() || config.hermesPython, hermesSource: hermesSource.trim() || config.hermesSource, port: config.port });
      console.log('Local configuration saved. Run nemo doctor, then nemo start. Use nemo invite on the host to pair your own phone.');
    } finally { prompt.close(); }
    return;
  }
  if (command === 'invite' && !args.length) {
    const store = await createProfileStore({ dataDir: config.dataDir }); const owner = await store.owner(); const invitation = await store.invite(owner.id);
    console.log(`Private invitation for ${owner.name}: ${invitation.code}\nExpires ${new Date(invitation.expiresAt).toLocaleString()}\nShare only with the intended person. Family invitations are available inside Nemo.`);
    return;
  }
  if (command === 'gmail' && args.length === 1) {
    const result = await installGmailWebClient({ dataDir: config.dataDir, clientPath: args[0], publicOrigin: config.publicOrigin });
    console.log(`Google Web OAuth configured. Register exactly: ${config.publicOrigin || `http://127.0.0.1:${config.port}`}/oauth/gmail/callback\nEach family member can now sign in from Connections. Existing grants were preserved.`);
    return;
  }
  if (command === 'start' && !args.length) {
    await mkdir(config.dataDir, { recursive: true });
    let child;
    const stop = () => { if(child?.connected)child.send({type:'nemo:stop'});else child?.kill('SIGTERM'); };
    const control = await createProcessControl({ dataDir: config.dataDir, onStop: stop });
    child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { cwd: APP_ROOT, env: { ...process.env, NEMO_DATA_DIR: config.dataDir }, stdio: ['inherit','inherit','inherit','ipc'], windowsHide: true });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.on('error', () => { console.error('Nemo could not start.'); process.exitCode = 1; });
    await new Promise(resolveExit => child.once('close', code => { process.exitCode = code || 0; resolveExit(); }));
    await control.close();
    return;
  }
  if (command === 'stop' && !args.length) { await stopManagedProcess(config.dataDir); console.log('Stop requested for this installation.'); return; }
  throw new Error(help);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

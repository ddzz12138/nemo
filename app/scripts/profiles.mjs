import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, cp, readdir, writeFile, readFile } from 'node:fs/promises';
import { createProfileStore, migrateProfiles, readJson, writeJson } from '../lib/profile-store.mjs';
import { migrateOwnerMemory } from '../lib/profile-memory.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.nemo');
const [command, ...args] = process.argv.slice(2);
async function offline() {
  try { const id = Number((await readFile(join(dataDir, 'server.pid'), 'utf8')).trim()); if (Number.isInteger(id) && id > 0) { try { process.kill(id, 0); throw Object.assign(new Error('Stop the managed Nemo process before migration or recovery.'), { live: true }); } catch (error) { if (error.live || error.code === 'EPERM') throw error; } } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const response = await fetch(`http://127.0.0.1:${Number(process.env.NEMO_PORT || 8787)}/api/health`, { signal: AbortSignal.timeout(2000) }); if (response.ok) throw Object.assign(new Error('Stop Nemo before running migration or owner recovery.'), { live: true }); }
  catch (error) { if (error.live) throw error; }
}
try {
  if (!command || ['--help', '-h'].includes(command)) {
    console.log('Family profile commands:\n  node scripts/profiles.mjs owner-invite\n  node scripts/profiles.mjs migrate --name "Your name"\n  node scripts/profiles.mjs recover-owner\n\nInvitations are private, single use, and expire in 24 hours. Recovery signs out all owner devices.');
  } else if (command === 'migrate' && args.length === 2 && args[0] === '--name') {
    await offline();
    if (!await readJson(join(dataDir, 'profiles.json'), null)) {
      const backup = join(dataDir, 'backups', `legacy-data-${Date.now()}`); await mkdir(backup, { recursive: true });
      for (const entry of await readdir(dataDir, { withFileTypes: true })) {
        if (['backups', 'server.pid', 'profiles.lock'].includes(entry.name) || /^server\..*\.log$/.test(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error('Private data contains a linked directory. Preserve and review it before migration.');
        await cp(join(dataDir, entry.name), join(backup, entry.name), { recursive: true, errorOnExist: true, force: false });
      }
      await writeFile(join(backup, 'BACKUP.txt'), 'Private legacy data backup before family profile migration, including Gmail ciphertext and the local GBrain database. Logs, process markers and prior backups excluded.\n');
      console.log(`Private data backup: ${backup}`);
    }
    const result = await migrateProfiles({ dataDir, ownerName: args[1] });
    const store = await createProfileStore({ dataDir }); const owner = await store.owner();
    const memory = await migrateOwnerMemory({ dataDir, profileId: owner.id });
    console.log(result.migrated ? 'Existing data moved into your private owner profile. Start Nemo and create an owner invitation.' : 'Family profiles are already initialized.');
    console.log(memory.migrated ? 'Owner memory is isolated in the owner profile. Other profiles start empty.' : 'No legacy memory needed migration.');
  } else if (['owner-invite', 'recover-owner'].includes(command) && args.length === 0) {
    if (command === 'recover-owner') await offline();
    const store = await createProfileStore({ dataDir });
    const owner = await store.owner();
    const invitation = command === 'recover-owner' ? await store.recoverOwner() : await store.invite(owner.id);
    if (command === 'recover-owner') {
      const leavePath = join(store.directory(owner.id), 'leave.json'); const leave = await readJson(leavePath, null);
      if (leave) { for (const item of leave.subscriptions || []) item.revoked = true; for (const item of leave.reminders || []) if (item.status === 'scheduled') item.status = 'cancelled'; await writeJson(leavePath, leave); }
    }
    console.log(`Personal invitation for ${invitation.profile.name}: ${invitation.code}\nExpires: ${new Date(invitation.expiresAt).toLocaleString()}\nEnter this code in Nemo on your own device. Keep it private.`);
  } else throw new Error('Use --help to see the supported profile commands.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

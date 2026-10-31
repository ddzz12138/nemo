import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat, copyFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { profileClassification, TOOL_CAPABILITIES, childReviewEnabled, mayReviewChild, policyRevision } from './family-policy.mjs';

export const DEVICE_MS = 90 * 86400_000;
const INVITE_MS = 86400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Private Nemo storage could not be read. Preserve the files before repairing them.'); }
}
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error; await pause(25 * 2 ** attempt); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'PROFILE_NAME', 'Enter a name between 1 and 60 characters.');
  return value.trim();
}
function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return [...bytes].map(value => alphabet[value & 31]).join('').match(/.{4}/g).join('-');
}
const normalized = value => typeof value === 'string' ? value.toUpperCase().replace(/[ -]/g, '') : '';
const passkeyId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(value);
const policyStamp = profile => `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}`;
const publicPasskey = key => ({ id: key.id, name: key.name, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt || null, backedUp: key.backedUp === true });
export const publicProfile = profile => ({ id: profile.id, name: profile.name, role: profile.role, classification: profileClassification(profile), policyRevision: profile.policyRevision || 0, disabled: profile.disabled, childMode: profile.childMode === true, createdAt: profile.createdAt, capabilityGrants: Object.fromEntries(TOOL_CAPABILITIES.map(id=>[id,profile.capabilityGrants?.[id]===true])), parentalReview: childReviewEnabled(profile) });
const publicDevice = device => ({ id: device.id, profileId: device.profileId, name: device.name, createdAt: device.createdAt, expiresAt: device.expiresAt, revokedAt: device.revokedAt || null });

export async function createProfileStore({ dataDir, now = Date.now, ownerName = 'Owner' }) {
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'profiles.json');
  const lockPath = join(dataDir, 'profiles.lock');
  let chain = Promise.resolve();
  async function exclusive(operation) {
    const pending = chain.catch(() => {}).then(async () => {
      let lock;
      const deadline = Date.now() + 10_000;
      while (!lock) {
        try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const saved = await readJson(lockPath, null).catch(() => null);
          let alive = true;
          if (saved?.pid) { try { process.kill(saved.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; } }
          else { try { alive = Date.now() - (await stat(lockPath)).mtimeMs < 30_000; } catch {} }
          if (!alive) { await unlink(lockPath).catch(() => {}); continue; }
          if (Date.now() > deadline) fail(503, 'PROFILE_BUSY', 'Profile storage is busy. Try again shortly.');
          await pause(30);
        }
      }
      try {
        let state = await readJson(path, null);
        if (!state) {
          if (await readJson(join(dataDir, 'state.json'), null)) fail(503, 'MIGRATION_REQUIRED', 'Run the local family-profile migration before starting Nemo.');
          const profile = { id: randomUUID(), name: name(ownerName), role: 'owner', disabled: false, createdAt: now() };
          state = { version: 2, ownerProfileId: profile.id, profiles: [profile], devices: [], invites: [], calendarTokens: {} };
        }
        if (state.version !== 2 || !Array.isArray(state.profiles) || !Array.isArray(state.devices) || !Array.isArray(state.invites) || !state.calendarTokens) throw new Error('Unsupported profile storage.');
        const result = await operation(state);
        await writeJson(path, state);
        return result;
      } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
    });
    chain = pending.then(() => {}, () => {});
    return pending;
  }
  await exclusive(() => {});
  async function snapshot() {
    const state = await readJson(path, null);
    if (state?.version !== 2) throw new Error('Profile storage is unavailable.');
    return state;
  }
  const activeDevice = (state, id) => {
    const device = state.devices.find(item => item.id === id);
    const profile = state.profiles.find(item => item.id === device?.profileId);
    return device && !device.revokedAt && device.expiresAt > now() && profile && !profile.disabled ? { device, profile } : null;
  };
  function createDevice(state, profile, deviceName, credentialId) {
    if (state.devices.filter(item => item.profileId === profile.id && !item.revokedAt && item.expiresAt > now()).length >= 10) fail(429, 'DEVICE_LIMIT', 'Sign out an old device before adding another.');
    const token = randomBytes(32).toString('hex');
    const device = { id: randomUUID(), profileId: profile.id, name: name(deviceName), tokenHash: hash(token), createdAt: now(), expiresAt: now() + DEVICE_MS, revokedAt: null, ...(credentialId ? { credentialId } : {}) };
    state.devices.push(device); return { token, profile: publicProfile(profile), device: publicDevice(device) };
  }
  return {
    async profiles() { return (await snapshot()).profiles.map(publicProfile); },
    async owner() { const state = await snapshot(); return publicProfile(state.profiles.find(item => item.id === state.ownerProfileId)); },
    async profile(id) { return (await snapshot()).profiles.find(item => item.id === id); },
    directory(id) { if (!UUID.test(id)) fail(400, 'PROFILE_ID', 'Choose a valid profile.'); return join(dataDir, 'profiles', id); },
    async authenticate(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const state = await snapshot();
      const device = state.devices.find(item => item.tokenHash === hash(token));
      return device ? activeDevice(state, device.id) : null;
    },
    async deviceActive(id, profileId) { const found = activeDevice(await snapshot(), id); return !!found && found.profile.id === profileId; },
    // Only trusted host transports call this after authenticating a device key.
    // No HTTP endpoint accepts a device ID as an authentication credential.
    async authenticateDevice(id) { return activeDevice(await snapshot(), id); },
    async devices(profileId) { return (await snapshot()).devices.filter(item => item.profileId === profileId).map(publicDevice); },
    async setCapability(id, capability, enabled) { return exclusive(state=>{
      const profile=state.profiles.find(item=>item.id===id);
      if(!profile||profileClassification(profile)!=='child')fail(400,'CHILD_PROFILE','Choose a child profile to manage its tools.');
      if(!TOOL_CAPABILITIES.includes(capability)||typeof enabled!=='boolean')fail(400,'CAPABILITY_INPUT','Choose a supported tool and whether to enable it.');
      profile.capabilityGrants||={};if(profile.capabilityGrants[capability]!==enabled){profile.capabilityGrants[capability]=enabled;profile.policyRevision=(profile.policyRevision||0)+1;}
      return publicProfile(profile);
    }); },
    async setParentalReview(id, enabled) { return exclusive(state=>{
      const profile=state.profiles.find(item=>item.id===id);
      if(!profile||profileClassification(profile)!=='child'||typeof enabled!=='boolean')fail(400,'CHILD_PROFILE','Choose whether to enable visible review for a child profile.');
      if(profile.parentalReview!==enabled){profile.parentalReview=enabled;profile.policyRevision=(profile.policyRevision||0)+1;}
      return publicProfile(profile);
    }); },
    async recordParentalReview(viewerId, childId, kind, expectedRevision) { return exclusive(state=>{
      const viewer=state.profiles.find(profile=>profile.id===viewerId),child=state.profiles.find(profile=>profile.id===childId);
      if(!mayReviewChild(viewer,child)||policyRevision(child)!==expectedRevision||!['history','memory'].includes(kind))fail(403,'PARENTAL_REVIEW','Review is not enabled for this child profile.');
      state.reviewAudit||=[];state.reviewAudit.push({id:randomUUID(),childId,viewerId,kind,at:now()});state.reviewAudit=state.reviewAudit.slice(-2000);return{ok:true};
    }); },
    async parentalReviewLog(profileId) { return ((await snapshot()).reviewAudit||[]).filter(entry=>entry.childId===profileId).slice(-50).reverse().map(entry=>({kind:entry.kind,at:entry.at,reviewer:'Family owner'})); },
    async passkeys(profileId) { return ((await snapshot()).passkeys || []).filter(key => key.profileId === profileId && !key.revokedAt).map(publicPasskey); },
    async passkey(id) { if (!passkeyId(id)) return null; const state = await snapshot(); const key = (state.passkeys || []).find(key => key.id === id && !key.revokedAt); const profile = key && state.profiles.find(profile => profile.id === key.profileId && !profile.disabled); return profile ? { key, profile } : null; },
    async addPasskey(profileId, deviceId, expectedPolicy, input) { return exclusive(state => {
      const auth = activeDevice(state, deviceId);
      if (!auth || auth.profile.id !== profileId || policyStamp(auth.profile) !== expectedPolicy) fail(401, 'PASSKEY_SESSION', 'This sign-in changed. Reload before adding a passkey.');
      const { id, publicKey, counter, rpID, deviceType, backedUp, transports = [], label = 'Personal passkey' } = input || {};
      if (!passkeyId(id) || typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{1,16384}$/.test(publicKey) || !Number.isSafeInteger(counter) || counter < 0 || typeof rpID !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(rpID) || !['singleDevice', 'multiDevice'].includes(deviceType) || typeof backedUp !== 'boolean' || !Array.isArray(transports) || transports.some(value => !['usb','nfc','ble','internal','hybrid','smart-card','cable'].includes(value))) fail(400, 'PASSKEY_INPUT', 'This passkey could not be saved.');
      state.passkeys ||= [];
      if (state.passkeys.some(key => key.id === id)) fail(409, 'PASSKEY_EXISTS', 'This passkey is already registered.');
      if (state.passkeys.filter(key => key.profileId === profileId && !key.revokedAt).length >= 10) fail(429, 'PASSKEY_LIMIT', 'Remove an old passkey before adding another.');
      const key = { id, profileId, publicKey, counter, rpID, deviceType, backedUp, transports, name: name(label), createdAt: now(), revokedAt: null };
      state.passkeys.push(key); return publicPasskey(key);
    }); },
    async signInPasskey({ id, expectedCounter, expectedPolicy, rpID, newCounter, backedUp, deviceName = 'Passkey browser' }) { return exclusive(state => {
      const key = (state.passkeys || []).find(key => key.id === id && !key.revokedAt);
      const profile = key && state.profiles.find(profile => profile.id === key.profileId && !profile.disabled);
      if (!profile || key.rpID !== rpID || key.counter !== expectedCounter || policyStamp(profile) !== expectedPolicy || !Number.isSafeInteger(newCounter) || newCounter < 0 || typeof backedUp !== 'boolean') fail(401, 'PASSKEY_SIGNIN', 'This passkey sign-in expired or changed. Try again.');
      const result = createDevice(state, profile, deviceName, id); key.counter = newCounter; key.backedUp = backedUp; key.lastUsedAt = now(); return result;
    }); },
    async revokePasskey(profileId, id) { return exclusive(state => {
      const key = (state.passkeys || []).find(key => key.profileId === profileId && key.id === id && !key.revokedAt);
      if (!key) fail(404, 'PASSKEY_NOT_FOUND', 'This passkey is not available in your profile.');
      key.revokedAt = now(); const revokedDevices = [];
      for (const device of state.devices) if (device.profileId === profileId && device.credentialId === id && !device.revokedAt) { device.revokedAt = now(); revokedDevices.push(publicDevice(device)); }
      return { ok: true, revokedDevices };
    }); },
    async create(displayName, childMode = false) { if (typeof childMode !== 'boolean') fail(400, 'PROFILE_INPUT', 'Choose whether to enable Child mode.'); return exclusive(state => { if (state.profiles.length >= 20) fail(429, 'PROFILE_LIMIT', 'This server supports up to 20 family profiles.'); const profile = { id: randomUUID(), name: name(displayName), role: 'member', disabled: false, childMode, childModeRevision: 0, createdAt: now() }; state.profiles.push(profile); return publicProfile(profile); }); },
    async setChildMode(id, enabled) { return exclusive(state => {
      if (typeof enabled !== 'boolean') fail(400, 'PROFILE_INPUT', 'Choose whether to enable Child mode.');
      const profile = state.profiles.find(item => item.id === id);
      if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
      if (profile.role === 'owner') fail(400, 'PROFILE_INPUT', 'Child mode is available for family members.');
      if ((profile.childMode === true) !== enabled) { profile.childMode = enabled; profile.childModeRevision = (profile.childModeRevision || 0) + 1; }
      return { ...profile };
    }); },
    async classify(id, classification) { return exclusive(state => {
      if (!['adult', 'child'].includes(classification)) fail(400, 'PROFILE_INPUT', 'Choose Adult or Child.');
      const profile = state.profiles.find(item => item.id === id);
      if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
      if (profile.role === 'owner') fail(400, 'OWNER_REQUIRED', 'The server owner already has an owner profile.');
      if (profileClassification(profile) !== classification || profile.childMode !== (classification === 'child')) {
        profile.classification = classification;
        profile.childMode = classification === 'child';
        profile.policyRevision = (profile.policyRevision || 0) + 1;
        profile.childModeRevision = (profile.childModeRevision || 0) + 1;
      }
      return { ...profile };
    }); },
    async rename(id, displayName) { return exclusive(state => { const profile = state.profiles.find(item => item.id === id); if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.'); profile.name = name(displayName); return publicProfile(profile); }); },
    async disable(id, disabled) { return exclusive(state => { const profile = state.profiles.find(item => item.id === id); if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.'); if (profile.role === 'owner') fail(400, 'OWNER_REQUIRED', 'The owner profile cannot be disabled.'); profile.disabled = disabled; if (disabled) { for (const device of state.devices) if (device.profileId === id) device.revokedAt ||= now(); state.invites = state.invites.filter(item => item.profileId !== id); } return publicProfile(profile); }); },
    async invite(profileId, createdBy = 'local-pc', { ttlMs = INVITE_MS } = {}) { return exclusive(state => {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > INVITE_MS) fail(400, 'INVITE_EXPIRY', 'Choose an invitation that expires within one day.');
      const profile = state.profiles.find(item => item.id === profileId && !item.disabled);
      if (!profile) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
      const code = inviteCode(); const expiresAt = now() + ttlMs;
      state.invites = state.invites.filter(item => !item.usedAt && item.expiresAt > now());
      if (state.invites.filter(item => item.profileId === profileId).length >= 10) fail(429, 'INVITE_LIMIT', 'Use an existing invitation or wait for it to expire.');
      state.invites.push({ id: randomUUID(), profileId, codeHash: hash(normalized(code)), createdBy, expiresAt });
      return { code, expiresAt, profile: publicProfile(profile) };
    }); },
    async previewInvite(code) {
      const state = await snapshot(), clean = normalized(code);
      const invite = /^[A-Z2-9]{16}$/.test(clean) ? state.invites.find(item => item.codeHash === hash(clean) && !item.usedAt && item.expiresAt > now()) : null;
      const profile = state.profiles.find(item => item.id === invite?.profileId && !item.disabled);
      if (!invite || !profile) fail(401, 'PAIR_INVALID', 'This invitation is invalid, expired, or already used. Ask for a new personal code.');
      return { profile: { id: profile.id, name: profile.name, childMode: profile.childMode === true, parentalReview: childReviewEnabled(profile) }, expiresAt: invite.expiresAt };
    },
    async redeem(code, deviceName = 'Personal browser', expectedProfileId) { return exclusive(state => {
      const clean = normalized(code);
      const invite = /^[A-Z2-9]{16}$/.test(clean) ? state.invites.find(item => item.codeHash === hash(clean) && !item.usedAt && item.expiresAt > now()) : null;
      const profile = state.profiles.find(item => item.id === invite?.profileId && !item.disabled);
      if (!invite || !profile) fail(401, 'PAIR_INVALID', 'This invitation is invalid, expired, or already used. Ask for a new personal code.');
      if (expectedProfileId !== undefined && expectedProfileId !== profile.id) fail(409, 'PAIR_CHANGED', 'This invitation changed. Check the person you are joining and try again.');
      if (state.devices.filter(item => item.profileId === profile.id && !item.revokedAt && item.expiresAt > now()).length >= 10) fail(429, 'DEVICE_LIMIT', 'Revoke an old device before adding another.');
      const token = randomBytes(32).toString('hex');
      const device = { id: randomUUID(), profileId: profile.id, name: name(deviceName), tokenHash: hash(token), createdAt: now(), expiresAt: now() + DEVICE_MS, revokedAt: null };
      invite.usedAt = now(); state.devices.push(device);
      return { token, profile: publicProfile(profile), device: publicDevice(device) };
    }); },
    async revoke(deviceId) { return exclusive(state => { const device = state.devices.find(item => item.id === deviceId); if (!device) fail(404, 'DEVICE_NOT_FOUND', 'Device not found.'); device.revokedAt ||= now(); return publicDevice(device); }); },
    async recoverOwner() { await exclusive(state => { for (const device of state.devices) if (device.profileId === state.ownerProfileId) device.revokedAt ||= now(); state.invites = state.invites.filter(item => item.profileId !== state.ownerProfileId); }); const owner = await this.owner(); return this.invite(owner.id); },
    async recordCalendarToken(profileId, token) { return exclusive(state => { for (const [key, id] of Object.entries(state.calendarTokens)) if (id === profileId) delete state.calendarTokens[key]; state.calendarTokens[hash(token)] = profileId; }); },
    async calendarProfile(token) { if (!/^[a-f0-9]{64}$/.test(token || '')) return null; const state = await snapshot(); const id = state.calendarTokens[hash(token)]; return state.profiles.find(item => item.id === id && !item.disabled) || null; },
  };
}

// Run only while the live gateway is stopped. The journal makes interrupted
// copies restartable, and the registry is published only after all copies exist.
export async function migrateProfiles({ dataDir, ownerName = 'Owner' }) {
  dataDir = resolve(dataDir);
  if (await readJson(join(dataDir, 'profiles.json'), null)) {
    const journalPath = join(dataDir, 'profiles-migration.json'); const journal = await readJson(journalPath, null);
    if (journal && journal.phase !== 'completed') { journal.phase = 'completed'; await writeJson(journalPath, journal); }
    return { migrated: false };
  }
  await mkdir(dataDir, { recursive: true });
  const journalPath = join(dataDir, 'profiles-migration.json');
  let journal = await readJson(journalPath, null);
  if (!journal) { journal = { version: 1, profileId: randomUUID(), ownerName: name(ownerName), phase: 'copying', startedAt: Date.now() }; await writeJson(journalPath, journal); }
  const id = journal.profileId;
  if (!UUID.test(id)) throw new Error('Invalid migration journal. Preserve the private backup.');
  const destination = join(dataDir, 'profiles', id);
  await mkdir(destination, { recursive: true });
  const legacy = await readJson(join(dataDir, 'state.json'), null);
  const sessions = Object.entries(legacy?.sessions || {}).map(([key, value]) => ({ ...value, legacyOwner: key })).sort((a, b) => (b.messages?.at(-1)?.createdAt || 0) - (a.messages?.at(-1)?.createdAt || 0));
  const active = sessions[0];
  const session = { conversationId: active?.conversationId || randomUUID(), expiresAt: Number.MAX_SAFE_INTEGER, messages: active?.messages || [], requestIds: active?.requestIds || {}, activeRunId: null, hermesSessionId: null, contextConsent: false, consentVersion: 0 };
  const runs = {};
  for (const [key, run] of Object.entries(legacy?.runs || {})) if (run.owner === active?.legacyOwner) runs[key] = { ...run, owner: id, ...(['running', 'queued'].includes(run.status) ? { status: 'failed', text: '', error: 'Nemo was upgraded before this reply completed.' } : {}) };
  await writeJson(join(destination, 'state.json'), { version: 1, pairingHash: '', sessions: { [id]: session }, runs });
  await writeJson(join(destination, 'history-archive.json'), sessions.slice(1).map(item => ({ id: item.conversationId, messages: item.messages || [] })));
  for (const file of ['calendar.json', 'gmail-tokens.dpapi', 'gmail-sync.dpapi', 'vapid.json']) {
    try { await copyFile(join(dataDir, file), join(destination, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const leave = await readJson(join(dataDir, 'leave.json'), null);
  if (leave) {
    for (const place of leave.places || []) place.owner = id;
    for (const subscription of leave.subscriptions || []) { subscription.owner = id; subscription.revoked = true; }
    for (const reminder of leave.reminders || []) { reminder.owner = id; if (['scheduled', 'sending'].includes(reminder.status)) { reminder.status = 'paused'; reminder.error = 'Pair your device and set this reminder again to enable notifications.'; reminder.claim = null; } }
    await writeJson(join(destination, 'leave.json'), leave);
  }
  const calendar = await readJson(join(destination, 'calendar.json'), null);
  await writeJson(join(dataDir, 'profiles.json'), { version: 2, ownerProfileId: id, profiles: [{ id, name: journal.ownerName, role: 'owner', disabled: false, createdAt: journal.startedAt }], devices: [], invites: [], calendarTokens: calendar?.tokenHash ? { [calendar.tokenHash]: id } : {} });
  journal.phase = 'completed'; await writeJson(journalPath, journal);
  return { migrated: true, profileId: id };
}

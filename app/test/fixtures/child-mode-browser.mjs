// Disposable UI fixture. No real profiles, credentials or AI inference.
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNemoServer } from '../../server.mjs';
const root = await mkdtemp(resolve('test/.tmp-child-ui-'));
const app = await createNemoServer({ dataDir: root, memoryFactory: null, ownerName: 'Test Owner', logger() {}, provider: { status: () => ({ connected: true }), async run() { return { text: 'Synthetic UI reply', sessionId: 'fixture' }; } } });
const owner = await app.profiles.owner(); const child = await app.profiles.create('Test Learner', true);
const ownerInvite = await app.profiles.invite(owner.id); const childInvite = await app.profiles.invite(child.id);
app.server.listen(8792, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:8792', ownerInvite: ownerInvite.code, childInvite: childInvite.code })));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (closing) return; closing = true; await app.close();
  if (!root.startsWith(resolve('test/.tmp-child-ui-'))) throw new Error('Unexpected fixture path.');
  await rm(root, { recursive: true, force: true }); process.exit(0);
});

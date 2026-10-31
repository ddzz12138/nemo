// Readiness describes verified adapters, never the existence of an upstream tool.
export const CAPABILITY_STATES = Object.freeze(['ready', 'needs_setup', 'disabled', 'unavailable', 'degraded']);
import {profileClassification,canUseCapability} from './family-policy.mjs';
export {profileClassification} from './family-policy.mjs';
export function capabilitySnapshot({ profile, provider = {}, readiness = {} } = {}) {
  if (!profile?.id) throw new Error('A trusted profile is required.');
  const classification = profileClassification(profile);
  const restricted = ['child', 'unclassified'].includes(classification);
  const item = (id, title, state, reason, setup = null) => ({ id, title, state, reason, setup });
  const pending = (id, title) => ({ ...item(id, title, canUseCapability(profile,id) ? 'needs_setup' : 'disabled', canUseCapability(profile,id) ? 'Not available in this version. The host will see when setup is supported.' : 'Ask the host to review this profile’s access.'), group:'more' });
  const capabilities = [
    item('chat', 'Chat with Hermes', provider.connected && readiness.chat ? 'ready' : 'needs_setup', provider.connected && readiness.chat ? 'Uses your private Nemo conversation.' : provider.connected ? 'Hermes was located. Send a message to verify it in this server session.' : 'The host needs to connect Hermes.', '/setup.html'),
    item('history', 'Conversation history', 'ready', 'Your private conversations, with search and native chat controls.', '/history.html'),
    item('activity', 'Live activity', 'ready', 'Live status, tool activity and memory outcomes.'),
    ...(readiness.native?.available?[item('native_preview','New chat connection',readiness.native.verified?'ready':'needs_setup',readiness.native.verified?'Private native chat with your permitted read tools and local Memory learning.':'Private chat preview. Connected reads use your saved permission. Send a message to verify the connection.','/native-chat.html')]:[]),
    item('gmail', 'Gmail', readiness.gmail ? 'ready' : 'needs_setup', readiness.gmail ? 'Your Google account is connected. Reads require your Connections consent.' : 'Connect your own Google account; access is read-only.', '/gmail-connect.html'),
    item('calendar', 'iPhone Calendar', readiness.calendar ? 'ready' : 'needs_setup', 'Reads your latest uploaded snapshot. Calendar stays outside Memory.', '/calendar-setup.html'),
    item('memory', 'Your Memory', readiness.memory ? 'ready' : 'needs_setup', readiness.memory ? 'Your private local Memory engine is connected.' : 'Enable and check the local Memory engine.', '/memory.html'),
    item('reminders', 'Leave reminders', 'needs_setup', 'Transport setup and phone notification permission must be checked.', '/leave.html'),
    ...[['research','Web research'],['browser','Browser automation'],['files','Files and documents'],['terminal','Terminal and code'],['desktop','Computer control'],['tasks','Background tasks'],['agents','Subagents and reviews'],['schedule','Scheduling'],['voice','Voice conversation'],['media','Image and video tools'],['extensions','Skills, MCP and plugins'],['models','Model controls and Mixture of Agents']].map(([id,title]) => pending(id,title)),
  ].map(capability=>!canUseCapability(profile,capability.id)&&capability.id!=='native_preview'?{...capability,state:'disabled',reason:classification==='child'?'Your family owner can enable this tool for your profile.':'Ask the host to review this profile’s access.'}:capability);
  return {version:1,classification,runtime:'guarded-cli',capabilities};
}

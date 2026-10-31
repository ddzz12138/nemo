export const TOOL_CAPABILITIES = Object.freeze(['memory','gmail','calendar','reminders','research','browser','files','terminal','desktop','tasks','agents','schedule','voice','media','extensions','models']);
const basic = new Set(['chat','history','activity']);
const existingReads = new Set(['memory','gmail','calendar','reminders']);
export function profileClassification(profile) {
  if (profile?.role === 'owner') return 'owner';
  if (profile?.childMode === true) return 'child';
  return ['adult','child'].includes(profile?.classification) ? profile.classification : 'unclassified';
}
export function canUseCapability(profile, capability) {
  if (!profile?.id || profile.disabled) return false;
  if (basic.has(capability)) return true;
  if (!TOOL_CAPABILITIES.includes(capability)) return false;
  const classification = profileClassification(profile);
  if (classification === 'child') return profile.capabilityGrants?.[capability] === true;
  if (classification === 'unclassified') return existingReads.has(capability);
  return true;
}
export const policyRevision = profile => `${profile.policyRevision || 0}:${profile.childModeRevision || 0}:${profile.childMode === true}`;
export const childReviewEnabled = profile => !!profile?.id && !profile.disabled && profileClassification(profile) === 'child' && profile.parentalReview !== false;
export const mayReviewChild = (viewer, target) => viewer?.role === 'owner' && !viewer.disabled && viewer.id !== target?.id && childReviewEnabled(target);
export function connectionToolNames(profile, {memoryEnabled=true}={}) {
  return [['calendar','calendar_list'],['gmail','gmail_search'],...(memoryEnabled?[['memory','memory_search']]:[])].filter(([capability])=>canUseCapability(profile,capability)).map(([,name])=>name);
}

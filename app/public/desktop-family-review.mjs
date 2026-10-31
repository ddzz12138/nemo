const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unavailable = () => Object.assign(new Error('Visible family review is not available for this profile.'), { code: 'REVIEW_UNAVAILABLE' });
const changed = () => Object.assign(new Error('This family review changed. Open it again from Family.'), { code: 'REVIEW_CHANGED' });

function identity(context) {
  const { owner, child } = context || {};
  if (owner?.role !== 'owner' || !ID.test(owner.id || '') || !ID.test(child?.id || '') || child.role === 'owner' || child.classification !== 'child' || child.parentalReview !== true || child.disabled) throw unavailable();
  return { ownerId: owner.id, childId: child.id, policy: child.policyRevision };
}

export function familyReviewPath(context, kind, conversation) {
  const { childId } = identity(context);
  if (!['history', 'memory'].includes(kind)) throw unavailable();
  if (conversation && (kind !== 'history' || !['main', 'native'].includes(conversation.source) || !ID.test(conversation.id || ''))) throw unavailable();
  return `/api/family/review/${childId}/${kind}${conversation ? `/${conversation.source}/${conversation.id}` : ''}`;
}

// This read-only adapter never changes the signed-in person or imports the
// child's information into the owner's assistant context. The HTTP API retains
// final authorization and records each completed review for the child.
export function createFamilyReviewReader({ request, getContext }) {
  let revision = 0;
  return {
    async read(kind, conversation) {
      const context = getContext(), before = identity(context), ticket = ++revision;
      const result = await request(familyReviewPath(context, kind, conversation));
      let after;
      try { after = identity(getContext()); } catch { throw changed(); }
      if (ticket !== revision || before.ownerId !== after.ownerId || before.childId !== after.childId || before.policy !== after.policy) throw changed();
      if (result.review?.readOnly !== true || result.review.kind !== kind || result.review.child?.id !== before.childId) throw changed();
      return result;
    },
    invalidate() { revision++; },
  };
}

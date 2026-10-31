import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyReviewReader, familyReviewPath } from '../public/desktop-family-review.mjs';

const owner = { id: '11111111-1111-4111-8111-111111111111', role: 'owner' };
const child = { id: '22222222-2222-4222-8222-222222222222', role: 'member', classification: 'child', parentalReview: true, policyRevision: 3, name: 'Synthetic child' };
const other = '33333333-3333-4333-8333-333333333333';
const conversation = { id: '44444444-4444-4444-8444-444444444444', source: 'main' };
const result = (kind = 'history', childId = child.id) => ({ review: { readOnly: true, kind, child: { id: childId, name: child.name } }, conversations: [] });

test('desktop review paths allow only explicitly enabled child review and fixed read-only content', () => {
  const context = { owner, child };
  assert.equal(familyReviewPath(context, 'history'), `/api/family/review/${child.id}/history`);
  assert.equal(familyReviewPath(context, 'memory'), `/api/family/review/${child.id}/memory`);
  assert.equal(familyReviewPath(context, 'history', conversation), `/api/family/review/${child.id}/history/main/${conversation.id}`);
  assert.equal(familyReviewPath(context, 'history', { ...conversation, source: 'native' }), `/api/family/review/${child.id}/history/native/${conversation.id}`);
  for (const context of [
    { owner: { ...owner, role: 'member' }, child },
    { owner, child: { ...child, classification: 'adult' } },
    { owner, child: { ...child, parentalReview: false } },
    { owner, child: { ...child, disabled: true } },
    { owner, child: { ...child, id: '../another' } },
  ]) assert.throws(() => familyReviewPath(context, 'history'), error => error.code === 'REVIEW_UNAVAILABLE');
  for (const [kind, selection] of [['delete', null], ['memory', conversation], ['history', { ...conversation, source: 'another' }], ['history', { ...conversation, id: '../another' }]]) assert.throws(() => familyReviewPath(context, kind, selection));
});

test('desktop review never dispatches a request for an adult or disabled review', async () => {
  let calls = 0;
  const reader = createFamilyReviewReader({ getContext: () => ({ owner, child: { ...child, classification: 'adult' } }), async request() { calls++; return result(); } });
  await assert.rejects(reader.read('history'), error => error.code === 'REVIEW_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('desktop review discards a response after either displayed person or child changes', async () => {
  for (const change of [context => ({ ...context, owner: { ...owner, id: other } }), context => ({ ...context, child: { ...child, id: other } }), context => ({ ...context, child: { ...child, parentalReview: false } }), context => ({ ...context, child: { ...child, policyRevision: 4 } })]) {
    let context = { owner, child }, release;
    const reader = createFamilyReviewReader({ getContext: () => context, request: () => new Promise(resolve => { release = resolve; }) });
    const pending = reader.read('history');
    context = change(context); release({ ...result(), private: 'LATE_CHILD_INFORMATION' });
    await assert.rejects(pending, error => error.code === 'REVIEW_CHANGED');
  }
});

test('new selections and leaving review invalidate older pending results', async () => {
  const releases = [];
  const reader = createFamilyReviewReader({ getContext: () => ({ owner, child }), request: () => new Promise(resolve => releases.push(resolve)) });
  const previous = reader.read('history'), current = reader.read('memory');
  releases[1](result('memory')); assert.equal((await current).review.kind, 'memory');
  releases[0](result()); await assert.rejects(previous, error => error.code === 'REVIEW_CHANGED');
  const closing = reader.read('history'); reader.invalidate(); releases[2](result());
  await assert.rejects(closing, error => error.code === 'REVIEW_CHANGED');
});

test('a review response must confirm its read-only purpose and exact child', async () => {
  for (const value of [result('history', other), result('memory'), { ...result(), review: { ...result().review, readOnly: false } }]) {
    const reader = createFamilyReviewReader({ getContext: () => ({ owner, child }), request: async () => value });
    await assert.rejects(reader.read('history'), error => error.code === 'REVIEW_CHANGED');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {bindReview, validateInput, digest} from './contract.mjs';

const input = {version: 1, lessonId: 'demo', narration: 'Zero is accepted.', sources: [{id: 'execution', text: 'age_zero=false'}]};
const finding = {severity: 'blocking', title: 'Wrong boundary', explanation: 'The executed boundary contradicts the draft.', suggestedChange: 'Describe zero as rejected.', evidence: [{sourceId: 'execution', quote: 'age_zero=false'}]};
test('a blocking finding prevents publication even when the model claims approval', () => {
  const r = bindReview(input, {findings: [finding], approvedForPublication: true});
  assert.equal(r.approvedForPublication, false);
  assert.equal(r.decision, 'BLOCKED_FOR_HUMAN_REVIEW');
});
test('a clean review still requires human review', () => {
  const r = bindReview(input, {findings: []});
  assert.equal(r.approvedForPublication, false);
  assert.equal(r.decision, 'REQUIRES_HUMAN_REVIEW');
});
test('invented source identifiers are rejected', () => assert.throws(() => bindReview(input, {findings: [{...finding, evidence: [{sourceId: 'not-supplied', quote: 'age_zero=false'}]}]}), /Unknown evidence/));
test('invented or altered source quotations are rejected', () => assert.throws(() => bindReview(input, {findings: [{...finding, evidence: [{sourceId: 'execution', quote: 'age_zero=true'}]}]}), /does not exist/));
test('a finding with no evidence is rejected', () => assert.throws(() => bindReview(input, {findings: [{...finding, evidence: []}]}), /needs evidence/));
test('ambiguous duplicate source identifiers are rejected', () => assert.throws(() => validateInput({...input, sources: [...input.sources, input.sources[0]]}), /unique/));
test('a source may not overwrite the narration evidence identifier', () => assert.throws(() => validateInput({...input, sources: [{id: 'narration', text: 'replacement'}]}), /unique/));
test('oversized inputs are rejected before inference', () => assert.throws(() => validateInput({...input, narration: 'x'.repeat(20001)}), /20000/));
test('a changed source produces a different evidence hash', () => {
  const a = bindReview(input, {findings: [finding]});
  const changed = {...input, sources: [{id: 'execution', text: 'new observation: age_zero=false'}]};
  const b = bindReview(changed, {findings: [finding]});
  assert.notEqual(a.inputSha256, b.inputSha256);
  assert.notEqual(a.findings[0].evidence[0].sourceSha256, b.findings[0].evidence[0].sourceSha256);
});
test('provenance distinguishes offline replay from live model inference', () => {
  assert.equal(bindReview(input, {findings: []}, {mode: 'OFFLINE_REPLAY_FIXTURE'}).provenance.mode, 'OFFLINE_REPLAY_FIXTURE');
  assert.equal(digest('same'), digest('same'));
});

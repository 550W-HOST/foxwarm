import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_ACTION_MARKER,
  buildChildCompletionInstruction,
  buildChildReminder,
  isModelNoActionSignal,
  isNoActionSignalText,
  partsContainNoActionSignal,
} from './childSessionReminder';

test('detects exact legacy and bracketed no-action markers', () => {
  assert.equal(isNoActionSignalText('NO_ACTION'), true);
  assert.equal(isNoActionSignalText(NO_ACTION_MARKER), true);
  assert.equal(isNoActionSignalText(`done\n${NO_ACTION_MARKER}`), true);
});

test('does not treat ordinary mentions as no-action signals', () => {
  assert.equal(isNoActionSignalText('Please do not literally print [NO_ACTION] here.'), false);
  assert.equal(isNoActionSignalText('prefix [NO_ACTION] suffix'), false);
});

test('checks message parts for the no-action signal', () => {
  assert.equal(partsContainNoActionSignal([{ text: 'done' }, { text: `summary\n${NO_ACTION_MARKER}` }]), true);
  assert.equal(partsContainNoActionSignal([{ text: 'done without marker' }]), false);
});

test('only model messages suppress child reminder via no-action signal', () => {
  assert.equal(isModelNoActionSignal({ role: 'model', parts: [{ text: NO_ACTION_MARKER }] }), true);
  assert.equal(isModelNoActionSignal({ role: 'tool', parts: [{ text: NO_ACTION_MARKER }] }), false);
});

test('child instructions and reminders recommend one flagged handoff and the bracketed marker', () => {
  const completion = buildChildCompletionInstruction('parent/main');
  const reminder = buildChildReminder('parent/main');

  assert.match(reminder, /^<foxwarm-system kind="child-reminder" event="missing-handoff" parentSessionId="parent\/main">\nReminder:[\s\S]*\n<\/foxwarm-system>$/);
  assert.match(completion, /\[NO_ACTION\]/);
  assert.match(reminder, /\[NO_ACTION\]/);
  assert.match(completion, /waitForReply: true/);
  assert.match(reminder, /waitForReply: true/);
  assert.doesNotMatch(completion, /wait\(\{\}\)/);
  assert.doesNotMatch(reminder, /wait\(\{\}\)/);
  assert.doesNotMatch(completion, /noFurtherAssistantReply/);
  assert.doesNotMatch(reminder, /noFurtherAssistantReply/);
  assert.doesNotMatch(reminder, /reply "NO_ACTION"/);
});

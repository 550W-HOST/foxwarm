import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_ACTION_MARKER,
  buildChildCompletionInstructionForMode,
  buildChildReminderForMode,
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

test('child instructions and reminders distinguish final reports from reply waits', () => {
  const completion = buildChildCompletionInstructionForMode('parent/main', false);
  const reminder = buildChildReminderForMode('parent/main', false);

  assert.match(reminder, /^<foxwarm-system kind="child-reminder" event="missing-handoff" parentSessionId="parent\/main">\nReminder:[\s\S]*\n<\/foxwarm-system>$/);
  assert.match(completion, /\[NO_ACTION\]/);
  assert.match(reminder, /\[NO_ACTION\]/);
  assert.match(completion, /afterSend: "finish"/);
  assert.match(reminder, /afterSend: "finish"/);
  assert.doesNotMatch(completion, /confirmation/);
  assert.doesNotMatch(reminder, /confirmation/);
  assert.match(completion, /ends the turn idle without creating a wait/);
  assert.match(reminder, /becomes idle/);
  assert.match(completion, /afterSend: "wait" only when you genuinely require a later reply/);
  assert.match(reminder, /afterSend: "wait" only when you genuinely require a later reply/);
  assert.doesNotMatch(completion, /waitAfterHandoff/);
  assert.doesNotMatch(reminder, /waitAfterHandoff/);
  assert.doesNotMatch(completion, /event-driven|any-event/);
  assert.doesNotMatch(reminder, /event-driven|any-event/);
  assert.doesNotMatch(completion, /wait\(\{\}\)/);
  assert.doesNotMatch(reminder, /wait\(\{\}\)/);
  assert.doesNotMatch(completion, /noFurtherAssistantReply/);
  assert.doesNotMatch(reminder, /noFurtherAssistantReply/);
  assert.doesNotMatch(reminder, /reply "NO_ACTION"/);
});

test('child instructions include confirmation guidance only when enabled', () => {
  const disabled = buildChildCompletionInstructionForMode('parent/main', false);
  const enabled = buildChildCompletionInstructionForMode('parent/main', true);
  const disabledReminder = buildChildReminderForMode('parent/main', false);
  const enabledReminder = buildChildReminderForMode('parent/main', true);

  assert.doesNotMatch(disabled, /confirmation/);
  assert.doesNotMatch(disabledReminder, /confirmation/);
  for (const text of [enabled, enabledReminder]) {
    assert.match(text, /replace the placeholder with your own review rather than copying it/);
    assert.match(text, /confirmation must be the final argument property/);
  }
});

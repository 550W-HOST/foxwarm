import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionLinkText, shouldUseStreamingToolPlaceholder } from './webuiToolRendering'

test('parseSessionLinkText linkifies create_child_session output and existing session references', () => {
  const child = parseSessionLinkText('Child session created: `example-agent/task1` (new session)')
  assert.deepEqual(child, [
    { type: 'session-link', text: 'Child session created: ', sessionId: 'example-agent/task1', kind: 'child-created' },
    { type: 'text', text: ' (new session)' },
  ])

  const mixed = parseSessionLinkText('Open session `parent` then sessionId: `child`')
  assert.deepEqual(mixed, [
    { type: 'text', text: 'Open ' },
    { type: 'session-link', text: 'session ', sessionId: 'parent', kind: 'session' },
    { type: 'text', text: ' then ' },
    { type: 'session-link', text: 'sessionId: ', sessionId: 'child', kind: 'sessionId' },
  ])
})

test('parseSessionLinkText links recognized Session fields in metadata attributes', () => {
  const canonical = parseSessionLinkText('<foxwarm-message type="inter-agent" sourceSessionId="agent/child" source="parent">\nbody')
  assert.deepEqual(canonical, [
    { type: 'text', text: '<foxwarm-message type="inter-agent" ' },
    { type: 'session-link', text: 'sourceSessionId="', sessionId: 'agent/child', kind: 'session-field' },
    { type: 'text', text: '" source="parent">\nbody' },
  ])

  const reordered = parseSessionLinkText('before <foxwarm-message sourceSessionId="agent/child" type="inter-agent"> after')
  assert.deepEqual(reordered, [
    { type: 'text', text: 'before <foxwarm-message ' },
    { type: 'session-link', text: 'sourceSessionId="', sessionId: 'agent/child', kind: 'session-field' },
    { type: 'text', text: '" type="inter-agent"> after' },
  ])

  assert.deepEqual(parseSessionLinkText('<foxwarm-message type="channel" sourceSessionId="agent/child">'), [
    { type: 'text', text: '<foxwarm-message type="channel" ' },
    { type: 'session-link', text: 'sourceSessionId="', sessionId: 'agent/child', kind: 'session-field' },
    { type: 'text', text: '">' },
  ])
  assert.deepEqual(parseSessionLinkText('<foxwarm-message type="task" createdBySessionId="creator/main" ownerSessionId="worker/main" previousOwnerSessionId="old/main" attachedSessionId="worker/main">'), [
    { type: 'text', text: '<foxwarm-message type="task" ' },
    { type: 'session-link', text: 'createdBySessionId="', sessionId: 'creator/main', kind: 'session-field' },
    { type: 'text', text: '" ' },
    { type: 'session-link', text: 'ownerSessionId="', sessionId: 'worker/main', kind: 'session-field' },
    { type: 'text', text: '" ' },
    { type: 'session-link', text: 'previousOwnerSessionId="', sessionId: 'old/main', kind: 'session-field' },
    { type: 'text', text: '" ' },
    { type: 'session-link', text: 'attachedSessionId="', sessionId: 'worker/main', kind: 'session-field' },
    { type: 'text', text: '">' },
  ])

  assert.deepEqual(parseSessionLinkText('<other sourceSessionId="agent/child">'), [
    { type: 'text', text: '<other ' },
    { type: 'session-link', text: 'sourceSessionId="', sessionId: 'agent/child', kind: 'session-field' },
    { type: 'text', text: '">' },
  ])

  assert.deepEqual(parseSessionLinkText('From sourceSessionId="agent/child" without a message wrapper.'), [
    { type: 'text', text: 'From ' },
    { type: 'session-link', text: 'sourceSessionId="', sessionId: 'agent/child', kind: 'session-field' },
    { type: 'text', text: '" without a message wrapper.' },
  ])

  const plain = 'sessionId: `<main>`; ownerSessionId: "<parent>"; sourceSessionId: null; legacyGoalSessionId="old/main"; unrelatedSessionId="other/main"'
  assert.deepEqual(parseSessionLinkText(plain), [
    { type: 'text', text: plain },
  ])

  assert.deepEqual(parseSessionLinkText('sessionId: `legacy`'), [
    { type: 'session-link', text: 'sessionId: ', sessionId: 'legacy', kind: 'sessionId' },
  ])
})

test('parseSessionLinkText links Task Session fields in JSON and YAML-shaped output', () => {
  const json = parseSessionLinkText('{"createdBySessionId":"creator/main","ownerSessionId":"worker/main","previousOwnerSessionId":null,"attachedSessionId":"worker/main"}')
  assert.deepEqual(json, [
    { type: 'text', text: '{' },
    { type: 'session-link', text: '"createdBySessionId":"', sessionId: 'creator/main', kind: 'session-field' },
    { type: 'text', text: '",' },
    { type: 'session-link', text: '"ownerSessionId":"', sessionId: 'worker/main', kind: 'session-field' },
    { type: 'text', text: '","previousOwnerSessionId":null,' },
    { type: 'session-link', text: '"attachedSessionId":"', sessionId: 'worker/main', kind: 'session-field' },
    { type: 'text', text: '"}' },
  ])

  const yaml = parseSessionLinkText('createdBySessionId: creator/main\nownerSessionId: worker/main')
  assert.deepEqual(yaml, [
    { type: 'session-link', text: 'createdBySessionId: ', sessionId: 'creator/main', kind: 'session-field' },
    { type: 'text', text: '\n' },
    { type: 'session-link', text: 'ownerSessionId: ', sessionId: 'worker/main', kind: 'session-field' },
  ])
})

test('shouldUseStreamingToolPlaceholder detects streaming partial tool calls only before responses', () => {
  assert.equal(shouldUseStreamingToolPlaceholder({
    modelMessageMeta: { synthetic: 'streamingAssistantDraft', streaming: true },
    hasCall: true,
    responseCount: 0,
    imagePartCount: 0,
  }), true)

  assert.equal(shouldUseStreamingToolPlaceholder({
    modelMessageMeta: { synthetic: 'streamingAssistantDraft', streaming: true },
    hasCall: true,
    responseCount: 1,
    imagePartCount: 0,
  }), false)

  assert.equal(shouldUseStreamingToolPlaceholder({
    modelMessageMeta: { streaming: false },
    hasCall: true,
    responseCount: 0,
    imagePartCount: 0,
  }), false)
})

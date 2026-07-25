import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionLinkText, shouldUseStreamingToolPlaceholder } from './webuiToolRendering'

test('parseSessionLinkText linkifies create_child_session output and existing session references', () => {
  const child = parseSessionLinkText('Child session created: `alphabot-dev/task1` (new session)')
  assert.deepEqual(child, [
    { type: 'session-link', text: 'Child session created: ', sessionId: 'alphabot-dev/task1', kind: 'child-created' },
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

test('parseSessionLinkText links only the sourceSessionId value in inter-agent opening tags', () => {
  const canonical = parseSessionLinkText('<foxwarm-message type="inter-agent" sourceSessionId="agent/child" source="parent">\nbody')
  assert.deepEqual(canonical, [
    { type: 'session-link', text: '<foxwarm-message type="inter-agent" sourceSessionId="', sessionId: 'agent/child', kind: 'inter-agent-source' },
    { type: 'text', text: '" source="parent">\nbody' },
  ])

  const reordered = parseSessionLinkText('before <foxwarm-message sourceSessionId="agent/child" type="inter-agent"> after')
  assert.deepEqual(reordered, [
    { type: 'text', text: 'before ' },
    { type: 'session-link', text: '<foxwarm-message sourceSessionId="', sessionId: 'agent/child', kind: 'inter-agent-source' },
    { type: 'text', text: '" type="inter-agent"> after' },
  ])

  assert.deepEqual(parseSessionLinkText('<foxwarm-message type="channel" sourceSessionId="agent/child">'), [
    { type: 'text', text: '<foxwarm-message type="channel" sourceSessionId="agent/child">' },
  ])
  assert.deepEqual(parseSessionLinkText('<other sourceSessionId="agent/child">'), [
    { type: 'text', text: '<other sourceSessionId="agent/child">' },
  ])
  assert.deepEqual(parseSessionLinkText('sessionId: `legacy`'), [
    { type: 'session-link', text: 'sessionId: ', sessionId: 'legacy', kind: 'sessionId' },
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

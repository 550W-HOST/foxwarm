import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionLinkText, shouldUseStreamingToolPlaceholder } from './webuiToolRendering'

test('parseSessionLinkText linkifies create_child_session output and existing session references', () => {
  const child = parseSessionLinkText('Child session created: `alphabot-dev/main_child` (new session)')
  assert.deepEqual(child, [
    { type: 'session-link', text: 'Child session created: ', sessionId: 'alphabot-dev/main_child', kind: 'child-created' },
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

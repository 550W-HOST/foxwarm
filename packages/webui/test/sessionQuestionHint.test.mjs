import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/sessionQuestionHint.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { getQuestionSectionPlacement, shouldShowQuestionHint, questionHintLabel, nextQuestionHintAnnouncement, QUESTION_SECTION_MIN_VISIBLE_PX } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('the section counts as out of view once less than a readable sliver remains below the visible top', () => {
  assert.equal(getQuestionSectionPlacement(null, 100), 'none')
  assert.equal(getQuestionSectionPlacement({ bottom: 300 }, 100), 'in-view')
  assert.equal(getQuestionSectionPlacement({ bottom: 100 + QUESTION_SECTION_MIN_VISIBLE_PX }, 100), 'in-view')
  assert.equal(getQuestionSectionPlacement({ bottom: 100 + QUESTION_SECTION_MIN_VISIBLE_PX - 1 }, 100), 'out')
  assert.equal(getQuestionSectionPlacement({ bottom: 40 }, 100), 'out')
})

test('the hint shows only for a rendered section that is out of view', () => {
  assert.equal(shouldShowQuestionHint(2, 'out'), true)
  assert.equal(shouldShowQuestionHint(2, 'in-view'), false)
  assert.equal(shouldShowQuestionHint(2, 'none'), false, 'a filtered list without the section shows no hint')
  assert.equal(shouldShowQuestionHint(0, 'out'), false)
})

test('the label counts Sessions with singular and plural forms', () => {
  assert.equal(questionHintLabel(1), '1 session waiting for your answer')
  assert.equal(questionHintLabel(2), '2 sessions waiting for your answer')
  assert.equal(questionHintLabel(12), '12 sessions waiting for your answer')
})

test('scrolling alone never announces; a count change while out of view announces once', () => {
  const step = (state, count, placement) => nextQuestionHintAnnouncement(state.baseline, count, placement)
  let state = { baseline: 0 }
  // Questions arrive while the section is visible, then the user scrolls away and back.
  state = step(state, 2, 'none'); assert.deepEqual(state, { baseline: 0, announce: false }, 'not yet measured')
  state = step(state, 2, 'in-view'); assert.deepEqual(state, { baseline: 2, announce: false })
  state = step(state, 2, 'out'); assert.deepEqual(state, { baseline: 2, announce: false })
  state = step(state, 2, 'in-view'); assert.equal(state.announce, false)
  // While scrolled away the count changes: each change is announced once.
  state = step(state, 2, 'out'); assert.equal(state.announce, false)
  state = step(state, 3, 'out'); assert.deepEqual(state, { baseline: 3, announce: true })
  state = step(state, 3, 'out'); assert.equal(state.announce, false)
  state = step(state, 1, 'out'); assert.deepEqual(state, { baseline: 1, announce: true })
  // The last question closes: the hint disappears silently.
  state = step(state, 0, 'none'); assert.deepEqual(state, { baseline: 0, announce: false })
  // A new question while the user is scrolled down makes the hint appear and announces it.
  state = step(state, 1, 'none'); assert.equal(state.announce, false)
  state = step(state, 1, 'out'); assert.deepEqual(state, { baseline: 1, announce: true })
})

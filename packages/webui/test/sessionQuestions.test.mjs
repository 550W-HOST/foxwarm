import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

globalThis.window ??= { location: { pathname: '/', origin: 'http://localhost' } }

const questions = await load('../src/sessionQuestions.ts')
const presentation = await load('../src/sessionListPresentation.ts')
const runtime = await load('../src/runtimeStatus.ts')
const notifications = await load('../src/sessionIdleNotifications.ts')

const single = { question: 'Database?', options: [{ label: 'PostgreSQL', recommended: true }, { label: 'SQLite' }] }
const multi = { ...single, multiSelect: true }

test('options toggle as radio unless the question allows several choices', () => {
  let entry = { selected: [], text: '' }
  entry = questions.toggleQuestionOption(single, entry, 'PostgreSQL')
  entry = questions.toggleQuestionOption(single, entry, 'SQLite')
  assert.deepEqual(entry.selected, ['SQLite'])
  assert.deepEqual(questions.toggleQuestionOption(single, entry, 'SQLite').selected, [])
  let several = { selected: [], text: '' }
  several = questions.toggleQuestionOption(multi, several, 'PostgreSQL')
  several = questions.toggleQuestionOption(multi, several, 'SQLite')
  assert.deepEqual(several.selected, ['PostgreSQL', 'SQLite'])
  assert.deepEqual(questions.toggleQuestionOption(multi, several, 'PostgreSQL').selected, ['SQLite'])
})

test('answer bodies pair entries with questions and trim free text and notes', () => {
  const draft = [{ selected: ['SQLite'], text: '  ' }, { selected: [], text: ' svc-data ' }]
  assert.equal(questions.canSubmitQuestionDraft(draft), true)
  assert.equal(questions.canSubmitQuestionDraft([{ selected: [], text: ' ' }]), false)
  assert.deepEqual(questions.buildQuestionAnswerBody(draft, ' backups '), { answers: [{ selected: ['SQLite'] }, { text: 'svc-data' }], note: 'backups' })
  assert.deepEqual(questions.buildQuestionAnswerBody(draft, ''), { answers: [{ selected: ['SQLite'] }, { text: 'svc-data' }] })
  assert.deepEqual(questions.buildQuestionSkipBody(''), { skip: true })
  assert.deepEqual(questions.buildQuestionSkipBody('later'), { skip: true, note: 'later' })
})

test('resolved outcomes read the structured answer or the answering message', () => {
  const record = { id: 'q-1', status: 'answered', questions: [single, { question: 'Name?' }], answer: { answers: [{ selected: ['SQLite'] }, { text: 'svc' }] } }
  assert.equal(questions.describeQuestionAnswer(record, 0), 'SQLite')
  assert.equal(questions.describeQuestionAnswer(record, 1), 'svc')
  const viaMessage = { id: 'q-2', status: 'answered', questions: [single], answer: { text: 'Use SQLite for now', viaMessage: true } }
  assert.equal(questions.describeQuestionAnswer(viaMessage, 0), 'Use SQLite for now')
  assert.equal(questions.questionOutcomeLabel({ status: 'skipped' }), 'Skipped')
  assert.equal(questions.questionOutcomeLabel({ status: 'closed' }), 'Closed')
})

test('ask_user calls are recognized directly and through call_tool', () => {
  assert.equal(questions.isAskUserCall({ name: 'ask_user', args: {} }), true)
  assert.equal(questions.isAskUserCall({ name: 'call_tool', args: { toolId: 'builtin:ask_user', args: {} } }), true)
  assert.equal(questions.isAskUserCall({ name: 'wait', args: {} }), false)
  assert.deepEqual(questions.askUserArgs({ name: 'call_tool', args: { toolId: 'builtin:ask_user', args: { close: 'q-1' } } }), { close: 'q-1' })
  assert.equal(questions.askUserQuestionId({}, { questionId: 'q-9', status: 'open' }), 'q-9')
  assert.equal(questions.askUserQuestionId({ close: 'q-3' }, undefined), 'q-3')
  assert.equal(questions.askUserQuestionId({}, { error: 'x' }), null)
})

test('Session list elevation: waiting questions first, open questions next, pin flag unchanged', () => {
  const rows = [
    { id: 'a', pinned: true },
    { id: 'b', questions: { open: 1 } },
    { id: 'c', questions: { open: 0 } },
    { id: 'd', questions: { open: 2, waiting: true } },
  ]
  assert.deepEqual(presentation.orderQuestionSessions(rows).map(row => row.id), ['d', 'b'])
  assert.equal(presentation.shouldElevateSessionToRoot(rows[1], 'default'), true)
  assert.equal(presentation.shouldElevateSessionToRoot(rows[2], 'default'), false)
  assert.equal(rows[1].pinned, undefined)
  assert.equal(questions.getSessionQuestionAttention(rows[3]), 'waiting')
  assert.equal(questions.getSessionQuestionAttention(rows[1]), 'open')
  assert.equal(questions.getSessionQuestionAttention(rows[2]), null)
})

test('a question wait reads as waiting for the user rather than external activity', () => {
  const view = runtime.getRuntimeStatusView({ state: 'waiting', queueLength: 0, busy: false, waiting: { waitId: 'w', waitingFor: 'question', waitQuestionIds: ['q-1'] } })
  assert.equal(view.label, 'Waiting for your answer')
  assert.equal(view.details.some(([, value]) => /external/i.test(value)), false)
})

test('watched Sessions notify once when they gain an open question', () => {
  const tracker = new notifications.SessionIdleNotificationTracker()
  const modes = { s: 'always' }
  const row = (open, revision) => ({ id: 's', runtimeState: { state: 'waiting', queueLength: 0, busy: false }, questions: { open, revision } })
  assert.deepEqual(tracker.observeQuestions([row(0, 0)], modes), [])
  assert.equal(tracker.observeQuestions([row(1, 1)], modes).length, 1)
  assert.deepEqual(tracker.observeQuestions([row(1, 1)], modes), [])
  assert.deepEqual(tracker.observeQuestions([row(0, 2)], modes), [])
  assert.deepEqual(tracker.observeQuestions([row(1, 3)], {}), [], 'unwatched Sessions do not notify')
})

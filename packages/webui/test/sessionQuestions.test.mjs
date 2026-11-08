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
const approvals = await load('../src/sessionApprovals.ts')

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

test('question notifications follow the browser-local mode', () => {
  const row = (id, open, revision) => ({ id, runtimeState: { state: 'waiting', queueLength: 0, busy: false }, questions: { open, revision } })
  const watched = { s: 'always' }
  const all = new notifications.SessionIdleNotificationTracker()
  assert.deepEqual(all.observeQuestions([row('s', 0, 0), row('t', 1, 1)], {}, 'all'), [], 'questions open at page load do not notify')
  assert.deepEqual(all.observeQuestions([row('s', 1, 1), row('t', 1, 1)], {}, 'all').map(item => item.id), ['s'], 'all sessions notify without a per-session toggle')
  assert.deepEqual(all.observeQuestions([row('s', 1, 1)], {}, 'all'), [], 'an unchanged question notifies once')
  assert.deepEqual(all.observeQuestions([row('s', 0, 2), row('u', 1, 1)], {}, 'all').map(item => item.id), ['u'], 'a session first seen with an open question notifies')
  assert.deepEqual(all.observeQuestions([row('t', 1, 1)], {}, 'all'), [], 'a row re-entering the list does not notify again')

  const onlyWatched = new notifications.SessionIdleNotificationTracker()
  onlyWatched.observeQuestions([row('s', 0, 0), row('t', 0, 0)], watched, 'watched')
  assert.deepEqual(onlyWatched.observeQuestions([row('s', 1, 1), row('t', 1, 1)], watched, 'watched').map(item => item.id), ['s'])

  const off = new notifications.SessionIdleNotificationTracker()
  off.observeQuestions([row('s', 0, 0)], watched, 'off')
  assert.deepEqual(off.observeQuestions([row('s', 1, 1)], watched, 'off'), [])
  assert.deepEqual(off.observeQuestions([row('s', 2, 2)], watched, 'all').map(item => item.id), ['s'], 'baselines continue while notifications are off')
})

test('question notification mode is stored per browser with All sessions as the default', () => {
  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  assert.equal(notifications.readQuestionNotificationMode(storage), 'all')
  notifications.writeQuestionNotificationMode(storage, 'off')
  assert.equal(store.get(notifications.QUESTION_NOTIFICATIONS_STORAGE_KEY), 'off')
  assert.equal(notifications.readQuestionNotificationMode(storage), 'off')
  notifications.writeQuestionNotificationMode(storage, 'watched')
  assert.equal(notifications.readQuestionNotificationMode(storage), 'watched')
  notifications.writeQuestionNotificationMode(storage, 'all')
  assert.equal(store.has(notifications.QUESTION_NOTIFICATIONS_STORAGE_KEY), false)
  assert.equal(notifications.readQuestionNotificationMode({ getItem: () => 'garbage' }), 'all')
  assert.equal(notifications.readQuestionNotificationMode({ getItem() { throw new Error('blocked') } }), 'all')
})

test('approval decisions trim notes and outcomes name who settled them', () => {
  assert.deepEqual(approvals.buildApprovalDecisionBody('approve', '  '), { decision: 'approve' })
  assert.deepEqual(approvals.buildApprovalDecisionBody('reject', ' use the staging host '), { decision: 'reject', note: 'use the staging host' })
  assert.equal(approvals.describeApprovalOutcome({ status: 'approved', decidedBy: { kind: 'identity', id: 'reviewer' } }), 'Approved by reviewer')
  assert.equal(approvals.describeApprovalOutcome({ status: 'rejected', decidedBy: { kind: 'administrator' } }), 'Rejected')
  assert.equal(approvals.describeApprovalOutcome({ status: 'expired', decidedBy: { kind: 'system', reason: 'restart' } }), 'Expired at restart')
  assert.equal(approvals.describeApprovalOutcome({ status: 'pending' }), 'Waiting for approval')
})

test('approval review text: tool identity, targets, deadline and shortened arguments', () => {
  assert.equal(approvals.approvalToolLabel({ source: 'mcp', server: 'tracker', name: 'close_issue' }), 'tracker · close_issue')
  assert.equal(approvals.approvalToolLabel({ source: 'node', name: 'exec' }), 'exec')
  assert.deepEqual(approvals.approvalTargets({ facts: { paths: [{ raw: 'a.txt', resolved: '/w/a.txt', node: 'dev' }], nodeTargets: ['dev'], sessionTarget: { id: 'peer' } } }), ['dev:/w/a.txt', 'Node dev', 'Session peer'])
  assert.equal(approvals.approvalTimeLeft(undefined), '')
  assert.equal(approvals.approvalTimeLeft(1_000 + 45_000, 1_000), '45s left')
  assert.equal(approvals.approvalTimeLeft(1_000 + 4 * 60_000, 1_000), '4m left')
  assert.equal(approvals.approvalTimeLeft(1_000 + 5 * 3_600_000, 1_000), '5h left')
  assert.equal(approvals.approvalTimeLeft(0, 1_000), '')
  assert.equal(approvals.approvalArgsText({ args: { command: 'ls' } }), '{\n  "command": "ls"\n}')
  assert.equal(approvals.approvalArgsText({ argsPreview: '{"command":"xx', argsTruncated: true }), '{"command":"xx…')
})

test('pending approvals read as waiting in the Session list and runtime status', () => {
  const row = { id: 'a', questions: { open: 2, approvals: 1, waiting: true } }
  assert.equal(questions.getSessionQuestionAttention(row), 'waiting')
  assert.equal(questions.questionAttentionLabel('waiting', 2, 1), 'Tool call waiting for approval')
  assert.equal(questions.questionAttentionLabel('waiting', 3, 3), '3 tool calls waiting for approval')
  assert.equal(questions.questionAttentionLabel('waiting', 1, 0), 'Waiting for your answer')
  const view = runtime.getRuntimeStatusView({ state: 'running-tool', queueLength: 0, busy: true, tool: { name: 'exec', source: 'node', startedAt: 1, approval: { id: 'ap-1', status: 'pending' } } })
  assert.equal(view.label, 'Waiting for approval · exec')
  assert.equal(view.tone, 'warning')
  assert.equal(runtime.getRuntimeStatusView({ state: 'running-tool', queueLength: 0, busy: true, tool: { name: 'exec', source: 'node', startedAt: 1 } }).label, 'Executing exec')
})

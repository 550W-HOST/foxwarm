import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadTypeScriptModule(relativePath) {
  const result = await build({ entryPoints: [new URL(relativePath, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

globalThis.window ??= { location: { pathname: '/', origin: 'http://localhost' } }
const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}

const drafts = await loadTypeScriptModule('../src/questionAnswerDrafts.ts')
const KEY = drafts.QUESTION_DRAFT_STORAGE_KEY
const record = {
  id: 'q-0123456789',
  questions: [
    { question: 'Database?', options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] },
    { question: 'Regions?', multiSelect: true, options: [{ label: 'Europe' }, { label: 'Asia' }] },
    { question: 'Name?' },
  ],
}
const filled = { entries: [{ selected: ['SQLite'], text: '' }, { selected: ['Europe', 'Asia'], text: 'later more' }, { selected: [], text: 'svc-data' }], step: 2, note: 'backups nightly', noteOpen: true }
const stored = () => JSON.parse(values.get(KEY) ?? 'null')
const reload = () => drafts.resetQuestionAnswerDraftCache()

beforeEach(() => { values.clear(); reload() })

test('a draft is restored per Session and question after a reload', () => {
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', record), drafts.emptyQuestionAnswerDraft(record))
  drafts.saveQuestionAnswerDraft('s-1', record.id, filled)
  reload()
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', record), filled)
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-2', record), drafts.emptyQuestionAnswerDraft(record))
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', { ...record, id: 'q-other' }), drafts.emptyQuestionAnswerDraft(record))
})

test('an empty draft is not stored and clears an earlier one', () => {
  drafts.saveQuestionAnswerDraft('s-1', record.id, drafts.emptyQuestionAnswerDraft(record))
  assert.equal(values.has(KEY), false)
  drafts.saveQuestionAnswerDraft('s-1', record.id, filled)
  drafts.saveQuestionAnswerDraft('s-1', record.id, drafts.emptyQuestionAnswerDraft(record))
  assert.equal(values.has(KEY), false)
})

test('clearing removes one draft and pruning keeps only open questions of that Session', () => {
  for (const [session, id] of [['s-1', 'q-a'], ['s-1', 'q-b'], ['s-1', 'q-c'], ['s-2', 'q-a']]) drafts.saveQuestionAnswerDraft(session, id, { ...filled, entries: filled.entries })
  drafts.clearQuestionAnswerDraft('s-1', 'q-a')
  drafts.pruneQuestionAnswerDrafts('s-1', ['q-b'])
  assert.deepEqual(stored().drafts.map(item => [item.sessionId, item.questionId]).sort(), [['s-1', 'q-b'], ['s-2', 'q-a']])
  drafts.pruneQuestionAnswerDrafts('s-1', [])
  drafts.pruneQuestionAnswerDrafts('s-2', [])
  assert.equal(values.has(KEY), false)
})

test('stored drafts are bounded by count and age', () => {
  for (let index = 0; index < drafts.MAX_STORED_QUESTION_DRAFTS + 5; index++) drafts.saveQuestionAnswerDraft('s-' + index, 'q-x', filled)
  const kept = stored().drafts
  assert.equal(kept.length, drafts.MAX_STORED_QUESTION_DRAFTS)
  assert.ok(kept.some(item => item.sessionId === 's-' + (drafts.MAX_STORED_QUESTION_DRAFTS + 4)), 'the newest draft is kept')

  values.set(KEY, JSON.stringify({ version: 1, drafts: [
    { sessionId: 's-old', questionId: record.id, updatedAt: Date.now() - drafts.QUESTION_DRAFT_MAX_AGE_MS - 1000, ...filled },
    { sessionId: 's-new', questionId: record.id, updatedAt: Date.now(), ...filled },
  ] }))
  reload()
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-old', record), drafts.emptyQuestionAnswerDraft(record))
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-new', record), filled)
  drafts.saveQuestionAnswerDraft('s-new', 'q-y', filled)
  assert.deepEqual(stored().drafts.map(item => item.sessionId), ['s-new', 's-new'])
})

test('malformed or mismatched stored drafts fall back to an empty draft', () => {
  values.set(KEY, '{not json')
  reload()
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', record), drafts.emptyQuestionAnswerDraft(record))
  values.set(KEY, JSON.stringify({ version: 1, drafts: [
    { sessionId: 's-1', questionId: record.id, updatedAt: Date.now(), entries: [{ selected: 'SQLite', text: '' }], step: 0, note: '', noteOpen: false },
    { sessionId: 's-2', questionId: record.id, updatedAt: Date.now(), ...filled, entries: filled.entries.slice(0, 2) },
    { sessionId: 's-3', questionId: record.id, updatedAt: Date.now(), ...filled,
      entries: [{ selected: ['SQLite', 'PostgreSQL', 'Gone'], text: '' }, { selected: ['Asia', 'Gone'], text: '' }, { selected: [], text: 'x' }], step: 9 },
  ] }))
  reload()
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', record), drafts.emptyQuestionAnswerDraft(record))
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-2', record), drafts.emptyQuestionAnswerDraft(record))
  // Unknown options are dropped, a single-choice question keeps one choice, and the step is clamped.
  assert.deepEqual(drafts.loadQuestionAnswerDraft('s-3', record), {
    entries: [{ selected: ['SQLite'], text: '' }, { selected: ['Asia'], text: '' }, { selected: [], text: 'x' }], step: 2, note: filled.note, noteOpen: true,
  })
})

test('drafts survive in the page when storage rejects writes', () => {
  const original = globalThis.localStorage.setItem
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
  try {
    drafts.saveQuestionAnswerDraft('s-1', record.id, filled)
    assert.deepEqual(drafts.loadQuestionAnswerDraft('s-1', record), filled)
  } finally {
    globalThis.localStorage.setItem = original
  }
})

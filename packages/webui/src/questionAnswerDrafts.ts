import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { emptyQuestionDraft, type QuestionDraftEntry, type QuestionRecord } from './sessionQuestions'

/**
 * Unsent answer to one open question set, kept per Session and question ID so every answer
 * form for that question shares it and it survives remounts and page reloads in this browser.
 */
export interface QuestionAnswerDraft {
  entries: QuestionDraftEntry[]
  step: number
  note: string
  noteOpen: boolean
}

interface StoredQuestionDraft extends QuestionAnswerDraft {
  sessionId: string
  questionId: string
  updatedAt: number
}

export const QUESTION_DRAFT_STORAGE_KEY = 'foxwarm_question_drafts_v1'
/** Newest drafts kept across all Sessions. */
export const MAX_STORED_QUESTION_DRAFTS = 50
/** Drafts untouched for this long are dropped. */
export const QUESTION_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const STORAGE_VERSION = 1
const draftKey = (sessionId: string, questionId: string) => `${sessionId}\n${questionId}`

let drafts: ReadonlyMap<string, StoredQuestionDraft> | null = null
const listeners = new Set<() => void>()

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function isEntry(value: unknown): value is QuestionDraftEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as QuestionDraftEntry
  return Array.isArray(entry.selected) && entry.selected.every(item => typeof item === 'string') && typeof entry.text === 'string'
}

function isStoredDraft(value: unknown): value is StoredQuestionDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as StoredQuestionDraft
  return typeof draft.sessionId === 'string' && !!draft.sessionId
    && typeof draft.questionId === 'string' && !!draft.questionId
    && typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
    && Array.isArray(draft.entries) && draft.entries.every(isEntry)
    && Number.isInteger(draft.step) && draft.step >= 0
    && typeof draft.note === 'string'
    && typeof draft.noteOpen === 'boolean'
}

/** Keeps the newest unexpired drafts within the storage bound. */
function bounded(items: Iterable<StoredQuestionDraft>, now = Date.now()): Map<string, StoredQuestionDraft> {
  const kept = [...items]
    .filter(item => now - item.updatedAt < QUESTION_DRAFT_MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_QUESTION_DRAFTS)
  return new Map(kept.map(item => [draftKey(item.sessionId, item.questionId), item]))
}

function readStorage(): Map<string, StoredQuestionDraft> {
  const raw = storage()?.getItem(QUESTION_DRAFT_STORAGE_KEY)
  if (!raw) return new Map()
  try {
    const parsed: unknown = JSON.parse(raw)
    const items = parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === STORAGE_VERSION ? (parsed as { drafts?: unknown }).drafts : null
    return Array.isArray(items) ? bounded(items.filter(isStoredDraft)) : new Map()
  } catch {
    return new Map()
  }
}

function current(): ReadonlyMap<string, StoredQuestionDraft> {
  if (!drafts) drafts = readStorage()
  return drafts
}

function commit(next: Map<string, StoredQuestionDraft>): void {
  drafts = bounded(next.values())
  const target = storage()
  if (target) {
    try {
      if (drafts.size) target.setItem(QUESTION_DRAFT_STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, drafts: [...drafts.values()] }))
      else target.removeItem(QUESTION_DRAFT_STORAGE_KEY)
    } catch {
      // Storage full or unavailable: the draft still survives remounts in this page.
    }
  }
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== QUESTION_DRAFT_STORAGE_KEY) return
  drafts = readStorage()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('storage', onStorage)
  }
}

export function emptyQuestionAnswerDraft(record: Pick<QuestionRecord, 'questions'>): QuestionAnswerDraft {
  return { entries: emptyQuestionDraft(record), step: 0, note: '', noteOpen: false }
}

function isEmptyDraft(draft: QuestionAnswerDraft): boolean {
  return draft.step === 0 && !draft.note && !draft.noteOpen && draft.entries.every(entry => !entry.selected.length && !entry.text)
}

/** Fits a stored draft to the question set: unknown options are dropped and the step is clamped. */
function fitDraft(record: Pick<QuestionRecord, 'questions'>, stored: QuestionAnswerDraft | undefined): QuestionAnswerDraft {
  const empty = emptyQuestionAnswerDraft(record)
  if (!stored || stored.entries.length !== record.questions.length) return empty
  const entries = record.questions.map((question, index) => {
    const labels = new Set((question.options || []).map(option => option.label))
    const selected = stored.entries[index].selected.filter(label => labels.has(label))
    return { selected: question.multiSelect ? selected : selected.slice(0, 1), text: stored.entries[index].text }
  })
  return { entries, step: Math.min(stored.step, Math.max(0, record.questions.length - 1)), note: stored.note, noteOpen: stored.noteOpen }
}

export function loadQuestionAnswerDraft(sessionId: string, record: Pick<QuestionRecord, 'id' | 'questions'>): QuestionAnswerDraft {
  return fitDraft(record, current().get(draftKey(sessionId, record.id)))
}

export function saveQuestionAnswerDraft(sessionId: string, questionId: string, draft: QuestionAnswerDraft): void {
  const next = new Map(current())
  const key = draftKey(sessionId, questionId)
  if (isEmptyDraft(draft)) {
    if (!next.delete(key)) return
  } else {
    next.set(key, { sessionId, questionId, updatedAt: Date.now(), entries: draft.entries, step: draft.step, note: draft.note, noteOpen: draft.noteOpen })
  }
  commit(next)
}

export function clearQuestionAnswerDraft(sessionId: string, questionId: string): void {
  const next = new Map(current())
  if (next.delete(draftKey(sessionId, questionId))) commit(next)
}

/** Drops this Session's drafts for questions that are no longer open. */
export function pruneQuestionAnswerDrafts(sessionId: string, openQuestionIds: Iterable<string>): void {
  const open = new Set(openQuestionIds)
  const next = new Map(current())
  let changed = false
  for (const [key, draft] of next) {
    if (draft.sessionId === sessionId && !open.has(draft.questionId)) { next.delete(key); changed = true }
  }
  if (changed) commit(next)
}

/** Test seam: forget the in-page copy so the next read comes from storage, as after a reload. */
export function resetQuestionAnswerDraftCache(): void {
  drafts = null
}

/** The shared draft for one question and an updater that stores each change. */
export function useQuestionAnswerDraft(sessionId: string, record: Pick<QuestionRecord, 'id' | 'questions'>): [QuestionAnswerDraft, (change: (draft: QuestionAnswerDraft) => QuestionAnswerDraft) => void] {
  const key = draftKey(sessionId, record.id)
  const stored = useSyncExternalStore(subscribe, () => current().get(key))
  const draft = useMemo(() => fitDraft(record, stored), [record, stored])
  const update = useCallback((change: (draft: QuestionAnswerDraft) => QuestionAnswerDraft) => {
    saveQuestionAnswerDraft(sessionId, record.id, change(loadQuestionAnswerDraft(sessionId, record)))
  }, [sessionId, record])
  return [draft, update]
}

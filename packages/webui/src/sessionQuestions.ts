import { API_BASE_PATH } from './config'

/** One `ask_user` option as stored by the Session. */
export interface QuestionOption {
  label: string
  description?: string
  recommended?: true
}

export interface QuestionItem {
  question: string
  options?: QuestionOption[]
  multiSelect?: true
}

export interface QuestionAnswerEntry {
  selected?: string[]
  text?: string
}

export type QuestionStatus = 'open' | 'answered' | 'skipped' | 'closed'

export interface QuestionRecord {
  id: string
  status: QuestionStatus
  createdAt?: number
  resolvedAt?: number
  toolCallId?: string
  questions: QuestionItem[]
  answer?: { answers?: QuestionAnswerEntry[]; text?: string; note?: string; viaMessage?: true }
  closeNote?: string
}

export interface SessionQuestionsView {
  sessionId?: string
  revision: number
  waitingQuestionIds: string[]
  questions: QuestionRecord[]
}

/** Bounded list/catalog projection carried by Session rows and Session state. */
export interface SessionQuestionsProjection {
  open: number
  revision?: number
  waiting?: true
}

export type SessionQuestionAttention = 'waiting' | 'open' | null

export function getSessionQuestionAttention(session: { questions?: SessionQuestionsProjection | null } | null | undefined): SessionQuestionAttention {
  const projection = session?.questions
  if (!projection || !(projection.open > 0)) return null
  return projection.waiting ? 'waiting' : 'open'
}

export function questionAttentionLabel(attention: SessionQuestionAttention, open = 1): string {
  if (attention === 'waiting') return 'Waiting for your answer'
  if (attention === 'open') return open === 1 ? 'Has an open question' : `Has ${open} open questions`
  return ''
}

/** Draft answer for one question: chosen labels plus the "other" text. */
export interface QuestionDraftEntry {
  selected: string[]
  text: string
}

export function emptyQuestionDraft(record: Pick<QuestionRecord, 'questions'>): QuestionDraftEntry[] {
  return record.questions.map(() => ({ selected: [], text: '' }))
}

/** Toggle one option: radio semantics unless the question allows several choices. */
export function toggleQuestionOption(question: QuestionItem, entry: QuestionDraftEntry, label: string): QuestionDraftEntry {
  if (question.multiSelect) {
    return { ...entry, selected: entry.selected.includes(label) ? entry.selected.filter(item => item !== label) : [...entry.selected, label] }
  }
  return { ...entry, selected: entry.selected.length === 1 && entry.selected[0] === label ? [] : [label] }
}

export function isQuestionDraftEntryAnswered(entry: QuestionDraftEntry | undefined): boolean {
  return !!entry && (entry.selected.length > 0 || entry.text.trim().length > 0)
}

export function canSubmitQuestionDraft(draft: readonly QuestionDraftEntry[]): boolean {
  return draft.some(isQuestionDraftEntryAnswered)
}

export interface QuestionAnswerBody {
  answers?: QuestionAnswerEntry[]
  note?: string
  skip?: true
}

export function buildQuestionAnswerBody(draft: readonly QuestionDraftEntry[], note: string): QuestionAnswerBody {
  const answers = draft.map(entry => {
    const result: QuestionAnswerEntry = {}
    if (entry.selected.length) result.selected = [...entry.selected]
    if (entry.text.trim()) result.text = entry.text.trim()
    return result
  })
  return note.trim() ? { answers, note: note.trim() } : { answers }
}

export function buildQuestionSkipBody(note: string): QuestionAnswerBody {
  return note.trim() ? { skip: true, note: note.trim() } : { skip: true }
}

/** Readable outcome of one question for a resolved card. */
export function describeQuestionAnswer(record: QuestionRecord, index: number): string {
  const answer = record.answer
  if (!answer) return ''
  if (answer.viaMessage) return answer.text || ''
  const entry = answer.answers?.[index]
  return [...(entry?.selected || []), ...(entry?.text ? [entry.text] : [])].join('; ')
}

export function questionOutcomeLabel(record: Pick<QuestionRecord, 'status'>): string {
  switch (record.status) {
    case 'answered': return 'Answered'
    case 'skipped': return 'Skipped'
    case 'closed': return 'Closed'
    default: return 'Waiting for your answer'
  }
}

/** Question ID from an `ask_user` tool result or its arguments when closing. */
export function askUserQuestionId(args: Record<string, unknown> | undefined, response: unknown): string | null {
  const result = response && typeof response === 'object' ? response as Record<string, unknown> : null
  if (result && typeof result.questionId === 'string') return result.questionId
  if (args && typeof args.close === 'string') return args.close
  return null
}

export function isAskUserCall(call: { name: string; args?: Record<string, unknown> } | undefined): boolean {
  if (!call) return false
  if (call.name === 'ask_user') return true
  return call.name === 'call_tool' && (call.args?.toolId === 'builtin:ask_user' || call.args?.source === 'builtin' && call.args?.name === 'ask_user')
}

export function askUserArgs(call: { name: string; args?: Record<string, unknown> }): Record<string, unknown> | undefined {
  if (call.name === 'call_tool') return call.args?.args && typeof call.args.args === 'object' ? call.args.args as Record<string, unknown> : undefined
  return call.args
}

export class QuestionAnswerError extends Error {
  constructor(message: string, readonly status: number, readonly notOpen: boolean) { super(message) }
}

export async function fetchSessionQuestions(sessionId: string, signal?: AbortSignal): Promise<SessionQuestionsView> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/questions`, { signal })
  if (!response.ok) throw new Error(`Questions could not be loaded (${response.status})`)
  return response.json()
}

export async function submitQuestionAnswer(sessionId: string, questionId: string, body: QuestionAnswerBody): Promise<void> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.ok) return
  const payload = await response.json().catch(() => ({}))
  throw new QuestionAnswerError(typeof payload?.error === 'string' ? payload.error : `The answer could not be sent (${response.status})`, response.status, payload?.code === 'QUESTION_NOT_OPEN')
}

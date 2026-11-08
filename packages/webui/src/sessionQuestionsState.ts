import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSessionQuestions, submitQuestionAnswer, type QuestionAnswerBody, type QuestionRecord, type SessionQuestionsProjection, type SessionQuestionsView } from './sessionQuestions'
import { submitApprovalDecision, type ApprovalDecisionBody, type ToolApprovalRecord } from './sessionApprovals'

export interface SessionQuestionsState {
  sessionId: string
  view: SessionQuestionsView | null
  byId: Map<string, QuestionRecord>
  open: QuestionRecord[]
  waitingIds: ReadonlySet<string>
  /** Pending tool approvals, oldest first. */
  approvals: ToolApprovalRecord[]
  approvalById: Map<string, ToolApprovalRecord>
  /** Approval records by the tool call that requested them. */
  approvalByCallId: Map<string, ToolApprovalRecord>
  submit: (questionId: string, body: QuestionAnswerBody) => Promise<void>
  decide: (approvalId: string, body: ApprovalDecisionBody) => Promise<void>
  reload: () => void
  /** Latest request from a timeline card to open the dock on one question or approval. */
  dockRequest: { questionId: string; nonce: number } | null
  requestDock: (questionId: string) => void
}

export const SessionQuestionsContext = createContext<SessionQuestionsState | null>(null)
export const useSessionQuestionsContext = () => useContext(SessionQuestionsContext)

/**
 * Session-owned question state for the dock and cards. Reloads when the Session state's
 * question projection revision changes, so it does not depend on loaded timeline rows.
 */
export function useSessionQuestions(sessionId: string, projection: SessionQuestionsProjection | null | undefined): SessionQuestionsState {
  const [view, setView] = useState<SessionQuestionsView | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [dockRequest, setDockRequest] = useState<{ questionId: string; nonce: number } | null>(null)
  const viewSessionRef = useRef(sessionId)
  const revision = projection?.revision ?? -1
  const hasState = !!projection
  useEffect(() => {
    if (viewSessionRef.current !== sessionId) { viewSessionRef.current = sessionId; setView(null) }
    if (!hasState) { setView(null); return }
    const controller = new AbortController()
    fetchSessionQuestions(sessionId, controller.signal)
      .then(next => { if (!controller.signal.aborted) setView(next) })
      .catch(error => { if (!controller.signal.aborted) console.error('Failed to load Session questions', error) })
    return () => controller.abort()
  }, [sessionId, revision, hasState, reloadToken])
  const reload = useCallback(() => setReloadToken(value => value + 1), [])
  const requestDock = useCallback((questionId: string) => setDockRequest(current => ({ questionId, nonce: (current?.nonce ?? 0) + 1 })), [])
  const submit = useCallback(async (questionId: string, body: QuestionAnswerBody) => {
    try { await submitQuestionAnswer(sessionId, questionId, body) }
    finally { reload() }
  }, [sessionId, reload])
  const decide = useCallback(async (approvalId: string, body: ApprovalDecisionBody) => {
    try { await submitApprovalDecision(sessionId, approvalId, body) }
    finally { reload() }
  }, [sessionId, reload])
  return useMemo(() => {
    const questions = view?.questions || []
    const approvals = view?.approvals || []
    return {
      sessionId,
      view,
      byId: new Map(questions.map(record => [record.id, record])),
      open: questions.filter(record => record.status === 'open'),
      waitingIds: new Set(view?.waitingQuestionIds || []),
      approvals: approvals.filter(record => record.status === 'pending'),
      approvalById: new Map(approvals.map(record => [record.id, record])),
      approvalByCallId: new Map(approvals.filter(record => record.toolCallId).map(record => [record.toolCallId!, record])),
      submit,
      decide,
      reload,
      dockRequest,
      requestDock,
    }
  }, [sessionId, view, submit, decide, reload, dockRequest, requestDock])
}

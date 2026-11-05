import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSessionQuestions, submitQuestionAnswer, type QuestionAnswerBody, type QuestionRecord, type SessionQuestionsProjection, type SessionQuestionsView } from './sessionQuestions'

export interface SessionQuestionsState {
  sessionId: string
  view: SessionQuestionsView | null
  byId: Map<string, QuestionRecord>
  open: QuestionRecord[]
  waitingIds: ReadonlySet<string>
  submit: (questionId: string, body: QuestionAnswerBody) => Promise<void>
  reload: () => void
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
  const submit = useCallback(async (questionId: string, body: QuestionAnswerBody) => {
    try { await submitQuestionAnswer(sessionId, questionId, body) }
    finally { reload() }
  }, [sessionId, reload])
  return useMemo(() => {
    const questions = view?.questions || []
    return {
      sessionId,
      view,
      byId: new Map(questions.map(record => [record.id, record])),
      open: questions.filter(record => record.status === 'open'),
      waitingIds: new Set(view?.waitingQuestionIds || []),
      submit,
      reload,
    }
  }, [sessionId, view, submit, reload])
}

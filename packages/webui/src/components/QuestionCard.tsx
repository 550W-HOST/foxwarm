import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronLeft, KeyRound, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react'
import {
  askUserArgs,
  askUserQuestionId,
  buildQuestionAnswerBody,
  buildQuestionSkipBody,
  canSubmitQuestionDraft,
  describeQuestionAnswer,
  isQuestionAnswered,
  QuestionAnswerError,
  questionOutcomeLabel,
  storedSecretLabel,
  toggleQuestionOption,
  type QuestionAnswerBody,
  type QuestionDraftEntry,
  type QuestionItem,
  type QuestionRecord,
} from '../sessionQuestions'
import { useSessionQuestionsContext } from '../sessionQuestionsState'
import { useQuestionAnswerDraft } from '../questionAnswerDrafts'
import { questionContentSummary } from '../questionContent'
import QuestionContent from './QuestionContent'
import type { FunctionCall, FunctionResponse } from './chatShared'
import { ApprovalDecisionForm } from './ApprovalCard'
import { approvalToolLabel, type ToolApprovalRecord } from '../sessionApprovals'
import type { SendKeyMode } from '../chatPreferences'
import { isImeComposing, isSendKey, sendShortcutLabel } from '../sendKey'

const isTextEntry = (target: EventTarget | null) => target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' && ['text', 'password'].includes((target as HTMLInputElement).type))

/**
 * Answer form for one open question set: step through the questions, then submit together.
 * The unsent answer is the Session's shared draft for this question, so it survives remounts.
 * In text fields the Chat send key advances or submits and other Enter presses insert a newline;
 * elsewhere in the form plain Enter advances too. Ctrl/Cmd+Enter advances from anywhere.
 */
export function QuestionAnswerForm({ sessionId, record, onSubmit, focusToken = 0, compact = false, sendKeyMode = 'modEnter' }: {
  sessionId: string
  record: QuestionRecord
  onSubmit: (body: QuestionAnswerBody) => Promise<void>
  /** Changing a nonzero value moves keyboard focus into the form. */
  focusToken?: number
  compact?: boolean
  sendKeyMode?: SendKeyMode
}) {
  const [{ entries: draft, step, note, noteOpen }, updateDraft] = useQuestionAnswerDraft(sessionId, record)
  const setStep = (change: (value: number) => number) => updateDraft(current => ({ ...current, step: change(current.step) }))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Typed secret values stay in this form's memory only, unlike the shared draft.
  const [secretValues, setSecretValues] = useState<Record<number, string>>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const otherId = useId()
  const total = record.questions.length
  const question = record.questions[step]
  const entry = draft[step]
  const last = step === total - 1
  useEffect(() => { setError(null); setSecretValues({}) }, [sessionId, record.id])
  useEffect(() => {
    if (!focusToken) return
    rootRef.current?.scrollIntoView({ block: 'nearest' })
    rootRef.current?.focus({ preventScroll: true })
  }, [focusToken])

  const update = (next: QuestionDraftEntry) => updateDraft(current => ({ ...current, entries: current.entries.map((item, index) => index === current.step ? next : item) }))
  const send = async (body: QuestionAnswerBody) => {
    setPending(true)
    setError(null)
    try {
      await onSubmit(body)
      setSecretValues({})
    } catch (cause) {
      setError(cause instanceof QuestionAnswerError && cause.notOpen ? 'This question was already resolved.' : cause instanceof Error ? cause.message : 'The answer could not be sent.')
    } finally { setPending(false) }
  }
  const canSubmit = canSubmitQuestionDraft(draft, record.questions, secretValues)
  const submit = () => { if (canSubmit && !pending) void send(buildQuestionAnswerBody(draft, note, record.questions, secretValues)) }
  const advance = () => { if (last) submit(); else setStep(value => value + 1) }
  const shortcut = sendShortcutLabel(sendKeyMode)
  const ariaShortcut = sendKeyMode === 'enter' ? 'Enter Control+Enter Meta+Enter' : 'Control+Enter Meta+Enter'
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys handled by an input method belong to the composition, including the Enter that commits it.
    if (pending || isImeComposing(event.nativeEvent)) return
    if (event.key === 'Enter') {
      if (isTextEntry(event.target)) {
        if (!isSendKey(event.nativeEvent, sendKeyMode)) return
      } else if (!event.ctrlKey && !event.metaKey && (event.shiftKey || event.altKey || event.target instanceof HTMLButtonElement)) {
        return
      }
      event.preventDefault()
      advance()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return
    const number = Number(event.key)
    const options = question.options || []
    if (Number.isInteger(number) && number >= 1 && number <= options.length) {
      event.preventDefault()
      update(toggleQuestionOption(question, entry, options[number - 1].label))
    }
  }

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={handleKeyDown} data-question-form={record.id} className="min-w-0 outline-none">
      {total > 1 && (
        <div className="mb-2 flex items-center gap-2 text-xs text-fw-text-muted">
          <span>Question {step + 1} of {total}</span>
          <span className="flex gap-1" aria-hidden="true">
            {record.questions.map((_, index) => <span key={index} className={`h-1.5 w-4 rounded-full ${index === step ? 'bg-fw-accent' : isQuestionAnswered(record.questions[index], draft[index], secretValues[index]) ? 'bg-fw-accent/40' : 'bg-fw-border'}`} />)}
          </span>
        </div>
      )}
      {question.secret
        ? <SecretQuestionBody question={question} value={secretValues[step] || ''} onChange={value => setSecretValues(current => ({ ...current, [step]: value }))} inputId={otherId} compact={compact} disabled={pending} />
        : <QuestionBody question={question} entry={entry} onChange={update} otherId={otherId} compact={compact} disabled={pending} />}
      {noteOpen ? (
        <label className="mt-2 block text-xs text-fw-text-muted">
          Note
          <textarea value={note} onChange={event => { const value = event.target.value; updateDraft(current => ({ ...current, note: value })) }} rows={2} disabled={pending} placeholder="Add context for your answer"
            className="mt-1 block w-full resize-y rounded-md border border-fw-border bg-fw-surface px-2 py-1.5 text-sm text-fw-text-strong outline-none placeholder:text-fw-text-muted focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring" />
        </label>
      ) : (
        <button type="button" onClick={() => updateDraft(current => ({ ...current, noteOpen: true }))} className="mt-2 text-xs text-fw-text-muted hover:text-fw-text hover:underline">Add a note</button>
      )}
      {error && <div role="alert" className="mt-2 text-xs text-fw-danger">{error}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {step > 0 && (
          <button type="button" disabled={pending} onClick={() => setStep(value => value - 1)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-fw-text-muted hover:bg-fw-hover hover:text-fw-text disabled:opacity-50">
            <ChevronLeft size={14} aria-hidden="true" />Back
          </button>
        )}
        <button type="button" disabled={pending} onClick={() => void send(buildQuestionSkipBody(note))} className="rounded-md px-2.5 py-1.5 text-sm text-fw-text-muted hover:bg-fw-hover hover:text-fw-text disabled:opacity-50">Skip</button>
        <span className="flex-1" />
        {last ? (
          <button type="button" disabled={pending || !canSubmit} onClick={submit} title={shortcut} aria-keyshortcuts={ariaShortcut} className="rounded-md bg-fw-accent px-3 py-1.5 text-sm font-medium text-fw-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {pending ? 'Sending…' : 'Submit'}
          </button>
        ) : (
          <button type="button" disabled={pending} onClick={advance} title={shortcut} aria-keyshortcuts={ariaShortcut} className="rounded-md bg-fw-accent px-3 py-1.5 text-sm font-medium text-fw-accent-text hover:opacity-90 disabled:opacity-50">Next</button>
        )}
      </div>
    </div>
  )
}

function QuestionBody({ question, entry, onChange, otherId, compact, disabled }: {
  question: QuestionItem
  entry: QuestionDraftEntry
  onChange: (entry: QuestionDraftEntry) => void
  otherId: string
  compact: boolean
  disabled: boolean
}) {
  const options = question.options || []
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className={`mb-2 whitespace-pre-wrap break-words font-medium text-fw-text-strong ${compact ? 'text-sm' : 'text-[15px]'}`}>{question.question}</legend>
      {question.multiSelect && options.length > 0 && <div className="-mt-1 mb-2 text-xs text-fw-text-muted">Choose one or more</div>}
      {options.length > 0 && (
        <div role={question.multiSelect ? 'group' : 'radiogroup'} className="flex flex-col gap-1">
          {options.map((option, index) => {
            const selected = entry.selected.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                data-question-option={option.label}
                onClick={() => onChange(toggleQuestionOption(question, entry, option.label))}
                className={`flex min-w-0 items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition ${selected ? 'border-fw-accent-border bg-fw-accent-surface dark:bg-fw-accent-surface-strong/30' : 'border-fw-border hover:bg-fw-hover'}`}
              >
                <span aria-hidden="true" className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border ${question.multiSelect ? 'rounded' : 'rounded-full'} ${selected ? 'border-fw-accent bg-fw-accent text-fw-accent-text' : 'border-fw-border-strong'}`}>
                  {selected && (question.multiSelect ? <Check size={12} strokeWidth={3} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-fw-text-strong">
                    <span className="break-words">{option.label}</span>
                    {option.recommended && <span className="rounded bg-fw-accent-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fw-accent dark:bg-fw-accent-surface-strong/40">Recommended</span>}
                  </span>
                  {option.description && <span className="mt-0.5 block break-words text-xs text-fw-text-muted">{option.description}</span>}
                </span>
                {!compact && <kbd aria-hidden="true" className="hidden shrink-0 rounded border border-fw-border px-1 text-[10px] text-fw-text-muted sm:inline">{index + 1}</kbd>}
              </button>
            )
          })}
        </div>
      )}
      <label htmlFor={otherId} className={`block text-xs text-fw-text-muted ${options.length ? 'mt-2' : ''}`}>{options.length ? 'Other' : 'Your answer'}</label>
      <textarea
        id={otherId}
        value={entry.text}
        rows={options.length ? 1 : 2}
        onChange={event => onChange({ ...entry, text: event.target.value })}
        placeholder={options.length ? 'Write a different answer' : 'Write your answer'}
        className={`mt-1 block max-h-40 w-full resize-y rounded-md border border-fw-border bg-fw-surface px-2 py-1.5 text-sm text-fw-text-strong outline-none [field-sizing:content] placeholder:text-fw-text-muted focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring ${options.length ? '' : 'min-h-[3.375rem]'}`}
      />
    </fieldset>
  )
}

/** A question answered with a credential, which is stored as a secret and not sent to the agent. */
function SecretQuestionBody({ question, value, onChange, inputId, compact, disabled }: {
  question: QuestionItem
  value: string
  onChange: (value: string) => void
  inputId: string
  compact: boolean
  disabled: boolean
}) {
  const secret = question.secret!
  return (
    <fieldset className="min-w-0" disabled={disabled} data-question-secret={secret.name}>
      <legend className={`mb-2 whitespace-pre-wrap break-words font-medium text-fw-text-strong ${compact ? 'text-sm' : 'text-[15px]'}`}>{question.question}</legend>
      <div className="mb-2 flex min-w-0 items-start gap-1.5 text-xs text-fw-text-muted">
        <KeyRound size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">
          Saved as secret <span className="font-mono text-fw-text">{secret.name}</span>{secret.description ? ` · ${secret.description}` : ''}. The agent can use it but never sees it.
        </span>
      </div>
      <label htmlFor={inputId} className="block text-xs text-fw-text-muted">Value</label>
      <input
        id={inputId}
        type="password"
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 block w-full rounded-md border border-fw-border bg-fw-surface px-2 py-1.5 font-mono text-sm text-fw-text-strong outline-none placeholder:text-fw-text-muted focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring"
      />
    </fieldset>
  )
}

/** Collapsed outcome of a resolved question set. */
export function QuestionOutcome({ record }: { record: QuestionRecord }) {
  const [expanded, setExpanded] = useState(false)
  const summary = record.status === 'answered'
    ? record.questions.length === 1 ? questionContentSummary(describeQuestionAnswer(record, 0), record.answer?.viaMessage) : `${record.questions.length} questions answered`
    : record.status === 'closed' ? questionContentSummary(record.closeNote || '') : ''
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-sm">
        <span className={`shrink-0 font-medium ${record.status === 'answered' ? 'text-fw-text-strong' : 'text-fw-text-muted'}`}>{questionOutcomeLabel(record)}</span>
        {summary && <span className="min-w-0 truncate text-fw-text-muted">· {summary}</span>}
        <ChevronDown size={14} aria-hidden="true" className={`ml-auto shrink-0 text-fw-text-muted ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          {record.questions.map((question, index) => (
            <div key={index} className="min-w-0">
              <dt className="mb-1 text-fw-text-muted"><QuestionContent text={question.question} /></dt>
              {record.status === 'answered' && <dd className="min-w-0 rounded-md border border-fw-border-muted bg-fw-surface-sunken/50 px-2.5 py-1.5"><QuestionContent text={describeQuestionAnswer(record, index) || 'No answer'} viaMessage={record.answer?.viaMessage} /></dd>}
            </div>
          ))}
          {record.answer?.note && <div className="text-fw-text-muted"><span className="text-xs">Note</span><QuestionContent text={record.answer.note} /></div>}
          {record.status === 'closed' && record.closeNote && <div className="text-fw-text-muted"><QuestionContent text={record.closeNote} /></div>}
        </dl>
      )}
    </div>
  )
}

function QuestionPreview({ questions }: { questions: QuestionItem[] }) {
  const [details, setDetails] = useState(false)
  const hasDetails = questions.some(question => question.options?.some(option => option.description))
  return (
    <div className="flex flex-col gap-2 text-sm">
      {questions.map((question, index) => (
        <div key={index} className="min-w-0">
          <div className="whitespace-pre-wrap break-words font-medium text-fw-text-strong">{question.question}</div>
          {question.secret && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fw-text-muted">
              <KeyRound size={13} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">Secret <span className="font-mono">{question.secret.name}</span></span>
            </div>
          )}
          {!!question.options?.length && (
            <ul className="mt-1 flex flex-col gap-0.5 pl-1 text-fw-text-muted">
              {question.options.map(option => (
                <li key={option.label} className="min-w-0 break-words">
                  <span className="text-fw-text">{option.label}</span>
                  {option.recommended && <span className="ml-1.5 rounded bg-fw-accent-surface px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fw-accent dark:bg-fw-accent-surface-strong/40">Recommended</span>}
                  {details && option.description && <span className="block text-xs">{option.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {hasDetails && (
        <button type="button" aria-expanded={details} onClick={event => { event.stopPropagation(); setDetails(value => !value) }} className="self-start text-xs text-fw-text-muted hover:text-fw-text hover:underline">
          {details ? 'Hide option details' : 'Show option details'}
        </button>
      )}
    </div>
  )
}

const cardClass = (tone: 'open' | 'waiting' | 'resolved') => `my-1 min-w-0 rounded-lg border px-3 py-2.5 ${
  tone === 'resolved' ? 'border-fw-border bg-fw-surface/60' : tone === 'waiting' ? 'border-fw-warning-border bg-fw-warning-surface/40 dark:bg-fw-warning-surface-strong/10' : 'border-fw-accent-border bg-fw-accent-surface/40 dark:bg-fw-accent-surface-strong/10'
}`

/** Timeline presentation of an `ask_user` call: an answer card while open, its outcome after. */
export function AskUserToolCard({ call, response }: { call: FunctionCall; response?: FunctionResponse }) {
  const questions = useSessionQuestionsContext()
  const args = askUserArgs(call)
  const questionId = askUserQuestionId(args, response?.response)
  const record = useMemo(() => {
    if (!questions) return undefined
    if (questionId && questions.byId.has(questionId)) return questions.byId.get(questionId)
    if (!args?.close && call.id) return [...questions.byId.values()].find(item => item.toolCallId === call.id)
    return undefined
  }, [questions, questionId, call.id, args?.close])
  const error = response?.response && typeof response.response === 'object' && (response.response as Record<string, unknown>).error
  if (typeof args?.close === 'string') {
    return (
      <div data-ask-user-close={args.close} className="my-1 flex min-w-0 items-center gap-1.5 px-1 text-xs text-fw-text-muted">
        <X size={13} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0">{error ? 'Could not close a question' : 'Closed a question'}</span>
        {typeof args.closeNote === 'string' && args.closeNote && <span className="min-w-0 truncate">· {args.closeNote}</span>}
      </div>
    )
  }
  const asked = Array.isArray(args?.questions) ? (args!.questions as QuestionItem[]).filter(item => item && typeof item.question === 'string') : []
  const waiting = !!record && questions?.waitingIds.has(record.id)
  const tone = !record || record.status !== 'open' ? 'resolved' : waiting ? 'waiting' : 'open'
  return (
    <div data-ask-user-card={record?.id || call.id} data-question-status={record?.status || (error ? 'error' : 'pending')} className={`${cardClass(tone)} ${tone !== 'resolved' ? 'cursor-pointer' : ''}`}
      onClick={tone !== 'resolved' && record && questions ? event => { if (!(event.target instanceof HTMLElement && event.target.closest('button'))) questions.requestDock(record.id) } : undefined}>
      <header className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-fw-text-muted">
        <MessageCircleQuestion size={14} aria-hidden="true" className={`shrink-0 ${tone === 'waiting' ? 'text-fw-warning' : tone === 'open' ? 'text-fw-accent' : ''}`} />
        <span>{asked.length > 1 ? 'Questions for you' : 'Question for you'}</span>
        {tone === 'waiting' && <span className="ml-auto shrink-0 font-medium text-fw-warning">Waiting for your answer</span>}
        {tone === 'open' && <span className="ml-auto shrink-0">Pending</span>}
      </header>
      {error ? (
        <><QuestionPreview questions={asked} /><div className="mt-2 text-xs text-fw-danger">The question could not be asked.</div></>
      ) : record?.status === 'open' && questions ? (
        <>
          <QuestionPreview questions={record.questions} />
          <button type="button" data-question-answer-open={record.id} onClick={() => questions.requestDock(record.id)}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-fw-border bg-fw-surface px-2.5 py-1 text-sm text-fw-text-strong hover:bg-fw-hover">
            Answer below
          </button>
        </>
      ) : record ? (
        <QuestionOutcome record={record} />
      ) : (
        <QuestionPreview questions={asked} />
      )}
    </div>
  )
}

type DockItem = { kind: 'approval'; id: string; record: ToolApprovalRecord } | { kind: 'question'; id: string; record: QuestionRecord }

const dockItemTitle = (item: DockItem): string => item.kind === 'approval'
  ? [approvalToolLabel(item.record.tool), item.record.summary].filter(Boolean).join(' · ')
  : item.record.questions[0]?.question || ''

function dockHeading(approvals: number, questions: number): string {
  if (!questions) return approvals === 1 ? 'Tool call needs approval' : `${approvals} tool calls need approval`
  if (!approvals) return questions === 1 ? 'Open question' : `${questions} open questions`
  return `${approvals + questions} open requests`
}

/**
 * Pinned dock above the composer, driven by Session state: pending tool approvals, which the
 * agent always waits on, then open questions answerable in place.
 */
export function QuestionDock({ isMobile = false, sendKeyMode = 'modEnter' }: { isMobile?: boolean; sendKeyMode?: SendKeyMode }) {
  const questions = useSessionQuestionsContext()
  const open = questions?.open || []
  const approvals = questions?.approvals || []
  const waitingAny = approvals.length > 0 || open.some(record => questions?.waitingIds.has(record.id))
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sessionId = questions?.sessionId
  const [focusToken, setFocusToken] = useState(0)
  useEffect(() => { setExpanded(null); setSelectedId(null) }, [sessionId])
  const request = questions?.dockRequest
  useEffect(() => {
    if (!request) return
    setExpanded(true)
    setSelectedId(request.questionId)
    setFocusToken(request.nonce)
  }, [request])
  if (!questions || open.length + approvals.length === 0) return null
  const ordered: DockItem[] = [
    ...approvals.map(record => ({ kind: 'approval' as const, id: record.id, record })),
    ...[...open]
      .sort((a, b) => Number(questions.waitingIds.has(b.id)) - Number(questions.waitingIds.has(a.id)))
      .map(record => ({ kind: 'question' as const, id: record.id, record })),
  ]
  const current = ordered.find(item => item.id === selectedId) || ordered[0]
  const isExpanded = expanded ?? waitingAny
  const isWaiting = (item: DockItem) => item.kind === 'approval' || questions.waitingIds.has(item.id)
  const Icon = approvals.length ? ShieldAlert : MessageCircleQuestion
  const waitingLabel = approvals.length ? 'Waiting for approval' : 'Waiting for your answer'
  return (
    <div data-question-dock data-question-dock-expanded={isExpanded ? 'true' : 'false'} className={`mb-2 min-w-0 rounded-lg border shadow-sm ${waitingAny ? 'border-fw-warning-border bg-fw-surface' : 'border-fw-accent-border bg-fw-surface'}`}>
      <button type="button" aria-expanded={isExpanded} onClick={() => setExpanded(!isExpanded)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm">
        <Icon size={16} aria-hidden="true" className={`shrink-0 ${waitingAny ? 'text-fw-warning' : 'text-fw-accent'}`} />
        <span className="shrink-0 font-medium text-fw-text-strong">{dockHeading(approvals.length, open.length)}</span>
        {!isExpanded && <span className="min-w-0 truncate text-fw-text-muted">· {dockItemTitle(current)}</span>}
        {waitingAny && <span className="ml-auto shrink-0 text-xs font-medium text-fw-warning">{isMobile ? 'Waiting' : waitingLabel}</span>}
        <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-fw-text-muted ${waitingAny ? '' : 'ml-auto'} ${isExpanded ? 'rotate-180' : ''}`} />
      </button>
      {isExpanded && (
        <div className="max-h-[min(55vh,28rem)] overflow-y-auto border-t border-fw-border px-3 pb-3 pt-2">
          {ordered.length > 1 && (
            <div role="tablist" aria-label="Open requests" className="mb-2 flex flex-wrap gap-1">
              {ordered.map((item, index) => (
                <button key={item.id} type="button" role="tab" aria-selected={item.id === current.id} data-dock-item={item.kind} onClick={() => setSelectedId(item.id)}
                  className={`max-w-[12rem] truncate rounded-md px-2 py-1 text-xs ${item.id === current.id ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/30' : 'text-fw-text-muted hover:bg-fw-hover'}`}
                  title={dockItemTitle(item)}>
                  {isWaiting(item) ? '● ' : ''}{index + 1}. {item.kind === 'approval' ? approvalToolLabel(item.record.tool) : dockItemTitle(item)}
                </button>
              ))}
            </div>
          )}
          {current.kind === 'approval' ? (
            <ApprovalDecisionForm key={current.id} record={current.record} sessionId={questions.sessionId} focusToken={current.id === request?.questionId ? focusToken : 0} onDecide={body => questions.decide(current.id, body)} />
          ) : (
            <>
              {!isWaiting(current) && <div className="mb-1 text-xs text-fw-text-muted">The agent keeps working while this is open.</div>}
              <QuestionAnswerForm key={current.id} sessionId={questions.sessionId} record={current.record} compact={isMobile} sendKeyMode={sendKeyMode} focusToken={current.id === request?.questionId ? focusToken : 0} onSubmit={body => questions.submit(current.id, body)} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Structured answer metadata stored on the answering user message. */
export interface QuestionAnswerMeta {
  questionId?: string
  questionIds?: string[]
  status?: 'answered' | 'skipped'
  questions?: string[]
  answers?: Array<{ selected?: string[]; text?: string; secret?: string }>
  note?: string
  viaMessage?: boolean
}

/** The model-facing marker on a message that answered a waited question; the bubble shows its own label. */
export const isQuestionAnswerMarker = (system: string): boolean => /^\s*<foxwarm-system\b[^>]*\bkind="question-answer"/.test(system)

export function isStructuredQuestionAnswer(meta: unknown): meta is QuestionAnswerMeta {
  return !!meta && typeof meta === 'object' && typeof (meta as QuestionAnswerMeta).questionId === 'string' && !(meta as QuestionAnswerMeta).viaMessage
}

/** User-bubble content for a card or dock answer: question and answer pairs, without protocol text. */
export function QuestionAnswerBubble({ answer }: { answer: QuestionAnswerMeta }) {
  const questions = useSessionQuestionsContext()
  const texts = answer.questions?.length ? answer.questions : questions?.byId.get(answer.questionId || '')?.questions.map(item => item.question) || []
  const skipped = answer.status === 'skipped'
  return (
    <div data-question-answer-bubble={skipped ? 'skipped' : 'answered'} className="flex min-w-0 flex-col gap-1.5 text-sm">
      {skipped && <div className="font-medium">Skipped {texts.length > 1 ? 'the questions' : 'the question'}</div>}
      {texts.map((question, index) => {
        const entry = answer.answers?.[index]
        const value = entry?.secret ? storedSecretLabel(entry.secret) : [...(entry?.selected || []), ...(entry?.text ? [entry.text] : [])].join('; ')
        return (
          <div key={index} className="min-w-0">
            <div className="text-xs opacity-75"><QuestionContent text={question} userBubble /></div>
            {!skipped && <QuestionContent text={value || 'No answer'} userBubble />}
          </div>
        )
      })}
      {answer.note && <div className="text-xs"><span className="opacity-75">Note: </span><QuestionContent text={answer.note} userBubble /></div>}
    </div>
  )
}

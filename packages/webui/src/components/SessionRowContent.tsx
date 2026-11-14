import { Archive, GitBranch, MessageCircleQuestion, Server, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Session } from './SessionListCore'
import RuntimeBusySpinner from './RuntimeBusySpinner'
import { getSessionRuntimeStateName, getSessionRuntimeSummary, getSessionRuntimeTone } from '../sessionRuntimeState'
import { getResolvedSessionNodeId } from '../sessionNode'
import { getSessionQuestionAttention, questionAttentionLabel } from '../sessionQuestions'

const activityTime = (timestamp: number): string => {
  if (!timestamp || !Number.isFinite(new Date(timestamp).getTime())) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

const getRuntimeBadgeTone = (session: Session): string => {
  const tone = getSessionRuntimeTone(session)
  return tone === 'muted' ? 'text-fw-text-muted' : `text-fw-${tone}`
}

const RuntimeActivityIndicator = ({ state }: { state: string }) => state === 'waiting'
  ? <span className="w-1.5 h-1.5 bg-fw-warning dark:bg-fw-warning rounded-full" />
  : state === 'llm-failed'
    ? <span className="w-1.5 h-1.5 bg-fw-danger rounded-full" />
    : <RuntimeBusySpinner />

export interface SessionRowContentProps {
  session: Session
  title: string
  compact: boolean
  /** The Agent tag the row names, or null. */
  agentTag: string | null
  paddingLeft: string
  displayId: string
  /** Real row only: the compact row's disclosure or its placeholder. */
  leading?: ReactNode
  /** Real row only: the child-sessions disclosure of the detailed row. */
  disclosure?: ReactNode
  unread?: boolean
  descendantBusyCount?: number
  mobileList?: boolean
  /** The drag overlay: the same content without the test and automation hooks of a real row. */
  preview?: boolean
}

/**
 * The title, Agent tag and status markers of a Session row, shared by the sidebar row and its drag
 * overlay. Menus, disclosure, hover actions and selection stay with the real row.
 */
export default function SessionRowContent({
  session,
  title,
  compact,
  agentTag,
  paddingLeft,
  displayId,
  leading,
  disclosure,
  unread = false,
  descendantBusyCount = 0,
  mobileList = false,
  preview = false,
}: SessionRowContentProps) {
  const hook = (name: string, value: string | true = true) => preview ? {} : { [name]: value }
  const runtimeStateName = getSessionRuntimeStateName(session)
  const showRuntimeBadge = session.runtimeState ? runtimeStateName !== 'idle' || !!session.runtimeState.compaction : !!session.busy
  const resolvedNodeId = getResolvedSessionNodeId(session)

  // The title truncates first; the tag keeps up to 45% of the row so the Agent stays readable.
  const agentTagBadge = agentTag && (
    <span
      {...hook('data-session-agent-tag', agentTag)}
      title={`Agent: ${agentTag}`}
      className="max-w-[45%] shrink-0 truncate rounded bg-fw-neutral-surface px-1.5 py-0.5 text-[10px] font-normal leading-none text-fw-text-muted"
    >
      {agentTag}
    </span>
  )

  const questionAttention = getSessionQuestionAttention(session)
  const questionLabel = questionAttentionLabel(questionAttention, session.questions?.open, session.questions?.approvals)
  const questionBadge = questionAttention && (
    <span role="img" aria-label={questionLabel} title={questionLabel} {...hook('data-session-question', questionAttention)}
      className={`inline-flex shrink-0 items-center justify-center ${questionAttention === 'waiting' ? 'h-5 w-5 rounded-full bg-fw-warning-surface text-fw-warning ring-1 ring-fw-warning-border dark:bg-fw-warning-surface-strong/30' : 'h-3.5 w-3.5 text-fw-accent'}`}>
      {(session.questions?.approvals ?? 0) > 0
        ? <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
        : <MessageCircleQuestion className="h-3.5 w-3.5" strokeWidth={questionAttention === 'waiting' ? 2.25 : 1.75} aria-hidden="true" />}
    </span>
  )

  const nodeBadge = resolvedNodeId !== 'master' && (
    <span
      role="img"
      aria-label={`Node: ${resolvedNodeId}`}
      title={`Node: ${resolvedNodeId}`}
      {...hook('data-session-node', resolvedNodeId)}
      className="inline-flex shrink-0 items-center justify-center text-fw-text-muted opacity-60"
    >
      <Server className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
    </span>
  )

  if (compact) {
    return (
      <div className="flex flex-1 min-w-0 items-center gap-1.5 py-1 pr-2 min-h-10" style={{ paddingLeft }}>
        {leading}
        <span className={"min-w-0 flex-1 truncate text-sm font-medium text-fw-text-strong"} title={`${title} · ${session.id}`} {...hook('data-session-title')}>
          {title}{session.runtime === 'claude-code' && <span className="ml-1 text-xs font-normal text-fw-text-muted">Claude Code</span>}
          {mobileList && activityTime(session.lastMessageTime) && <span className="mt-0.5 block truncate text-xs font-normal text-fw-text-muted">{session.agent ? `${session.agent} · ` : ''}{activityTime(session.lastMessageTime)}</span>}
        </span>
        {agentTagBadge}
        {questionBadge}
        {session.archived && <Archive className="h-3 w-3 shrink-0 text-fw-text-muted" aria-label="Archived session" />}
        {unread && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-fw-accent" role="img" aria-label="Unread idle completion" title="Unread idle completion" />
        )}
        {nodeBadge}
        {descendantBusyCount > 0 && (
          <span role="img" aria-label="Active descendant sessions" title={`${descendantBusyCount} active descendant ${descendantBusyCount === 1 ? 'session' : 'sessions'}`} className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-fw-accent" {...hook('data-descendant-activity')}>
            <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
        {showRuntimeBadge && (
          <span
            role="img"
            aria-label={`Status: ${getSessionRuntimeSummary(session)}`}
            title={`${getSessionRuntimeSummary(session)}${session.runtimeState?.note ? ` · ${session.runtimeState.note}` : ''}`}
            {...hook('data-session-status', runtimeStateName)}
            className={`session-compact-status ${getRuntimeBadgeTone(session)}`}
          >
            <RuntimeActivityIndicator state={runtimeStateName} />
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-1 min-w-0 items-start py-3 pr-2" style={{ paddingLeft }}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fw-text-strong">
          <span className={"min-w-0 flex-1 truncate"} {...hook('data-session-title')}>
            {title}{session.runtime === 'claude-code' && <span className="ml-1 text-xs font-normal text-fw-text-muted">Claude Code</span>}
            {unread && (
              <span className="ml-1.5 inline-flex items-center align-middle">
                <span className="h-2 w-2 rounded-full bg-fw-accent" aria-hidden="true" />
                <span className="sr-only">Unread idle completion</span>
              </span>
            )}
            {session.archived && (
              <span className="ml-2 text-xs text-fw-text-muted">[Archived]</span>
            )}
          </span>
          {questionBadge}
          {agentTagBadge}
        </div>
        {session.displayName && (
          <div className="text-xs text-fw-text-muted font-mono truncate">
            {displayId}
          </div>
        )}
        <div className="text-xs text-fw-text-muted flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {nodeBadge}
          {resolvedNodeId !== 'master' && <span>•</span>}
          {showRuntimeBadge && (
            <>
              <span className={`inline-flex items-center gap-1 ${getRuntimeBadgeTone(session)}`} title={session.runtimeState?.note || undefined}>
                <RuntimeActivityIndicator state={runtimeStateName} />
                <span>{getSessionRuntimeSummary(session)}</span>
              </span>
              <span>•</span>
            </>
          )}
          {!!session.queueLength && (
            <>
              <span>{session.queueLength} queued</span>
              <span>•</span>
            </>
          )}
          <span>{session.sequenceMessageCount ?? session.messageCount ?? 0} msgs</span>
        </div>
        {disclosure}
      </div>
    </div>
  )
}

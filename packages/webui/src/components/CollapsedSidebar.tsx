import { PanelLeftOpen, Plus } from 'lucide-react'
import type { Session } from './SessionListCore'
import { getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'

interface CollapsedSidebarProps {
  sessions: Session[]
  currentSession: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onToggleCollapsed: () => void
  unreadSessionIds?: ReadonlySet<string>
}

function getSessionInitial(session: Session): string {
  const title = session.displayName || session.id
  const trimmed = title.trim()
  if (!trimmed) return '•'
  const firstCodePoint = Array.from(trimmed)[0]
  return firstCodePoint.toUpperCase()
}

export default function CollapsedSidebar({
  sessions,
  currentSession,
  onSelectSession,
  onCreateSession,
  onToggleCollapsed,
  unreadSessionIds = new Set(),
}: CollapsedSidebarProps) {
  const rootSessions = sessions
    .filter((s) => (s.pinned || !s.parentSessionId) && !s.archived)

  return (
    <div className="h-full w-12 flex flex-col items-center bg-fw-surface border-r border-fw-border">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 py-3 border-b border-fw-border w-full">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCreateSession}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition"
          title="New session"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Session rail */}
      <div className="flex-1 flex flex-col items-center gap-1.5 py-2 overflow-y-auto w-full scrollbar-none">
        {rootSessions.slice(0, 20).map((session) => {
          const isActive = session.id === currentSession
          const initial = getSessionInitial(session)
          const runtimeState = getSessionRuntimeStateName(session)
          const activeRuntime = isSessionRuntimeActive(session)
          const showRuntimeIndicator = activeRuntime || runtimeState === 'waiting'
          const isUnread = unreadSessionIds.has(session.id)
          const indicatorColor = runtimeState === 'running-tool'
            ? 'bg-fw-special'
            : runtimeState === 'waiting'
              ? 'bg-fw-warning'
              : 'bg-fw-accent'
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              title={`${session.displayName || session.id}${isUnread ? ' — Unread idle completion' : ''}`}
              aria-label={`${session.displayName || session.id}${isUnread ? ', Unread idle completion' : ''}`}
              className={`relative flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition shrink-0 ${
                isActive
                  ? 'bg-fw-accent-surface text-fw-accent ring-1 ring-fw-focus-ring dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent dark:ring-fw-focus-ring'
                  : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text dark:hover:bg-fw-hover'
              }`}
            >
              {initial}
              {showRuntimeIndicator && (
                <span aria-hidden="true" className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-fw-focus-ring dark:ring-fw-focus-ring ${indicatorColor}`} />
              )}
              {isUnread && <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-fw-accent ring-1 ring-fw-focus-ring dark:ring-fw-focus-ring" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

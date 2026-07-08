import { PanelLeftOpen, Plus } from 'lucide-react'
import type { Session } from './SessionListCore'
import { getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'

interface CollapsedSidebarProps {
  sessions: Session[]
  currentSession: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onToggleCollapsed: () => void
}

function getSessionInitial(session: Session): string {
  const title = session.displayName || session.id
  const trimmed = title.trim()
  if (!trimmed) return '•'
  const firstCodePoint = Array.from(trimmed)[0]
  return firstCodePoint.toUpperCase()
}

function compareCollapsedSidebarSessions(a: Session, b: Session): number {
  const aOrder = typeof a.sidebarOrder === 'number' && Number.isFinite(a.sidebarOrder) ? a.sidebarOrder : undefined
  const bOrder = typeof b.sidebarOrder === 'number' && Number.isFinite(b.sidebarOrder) ? b.sidebarOrder : undefined
  if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder
  if (aOrder !== undefined && bOrder === undefined) return -1
  if (aOrder === undefined && bOrder !== undefined) return 1
  const timeDelta = (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
  if (timeDelta !== 0) return timeDelta
  return a.id.localeCompare(b.id)
}

export default function CollapsedSidebar({
  sessions,
  currentSession,
  onSelectSession,
  onCreateSession,
  onToggleCollapsed,
}: CollapsedSidebarProps) {
  const rootSessions = sessions.filter((s) => !s.parentSessionId && !s.archived).sort(compareCollapsedSidebarSessions)

  return (
    <div className="h-full w-12 flex flex-col items-center bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 py-3 border-b border-gray-200 dark:border-gray-700 w-full">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white transition"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCreateSession}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white transition"
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
          const indicatorColor = runtimeState === 'running-tool'
            ? 'bg-purple-500'
            : runtimeState === 'waiting'
              ? 'bg-amber-500'
              : 'bg-blue-500'
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              title={session.displayName || session.id}
              className={`relative flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition shrink-0 ${
                isActive
                  ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300 dark:bg-blue-900/40 dark:text-blue-200 dark:ring-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-600'
              }`}
            >
              {initial}
              {showRuntimeIndicator && (
                <span className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-white dark:ring-gray-800 ${indicatorColor}`} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

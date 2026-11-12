import { getSessionRuntimeTone } from '../sessionRuntimeState'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'
import { PanelLeftOpen, Plus, Search, ClipboardList, Network } from 'lucide-react'
import type { Session } from './SessionListCore'
import { getSessionRuntimeStateName, isSessionRuntimeActive, getSessionRuntimeSummary } from '../sessionRuntimeState'

interface CollapsedSidebarProps {
  sessions: Session[]
  currentSession: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onSelectSearch: () => void
  onSelectArchitecture?: () => void
  /** Highlights the matching navigation icon. */
  activeView?: 'system' | 'tasks' | 'search'
  onSelectSetup: () => void
  onSelectLogs: () => void
  /** Highlights the Setup gear while Setup or Logs is the current view. */
  setupActive?: boolean
  onSelectTasks?: () => void
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
  onSelectSearch,
  onSelectArchitecture,
  activeView,
  onSelectSetup,
  onSelectLogs,
  setupActive = false,
  onSelectTasks,
  onToggleCollapsed,
  unreadSessionIds = new Set(),
}: CollapsedSidebarProps) {
  const rootSessions = sessions
    .filter((s) => (s.pinned || !s.parentSessionId) && !s.archived)

  return (
    <div className="foxwarm-sidebar-panel h-full w-12 flex flex-col items-center bg-fw-sidebar-surface border-r border-fw-border">
      {/* Header and navigation, as in the expanded sidebar */}
      <div className="flex w-full flex-col items-center gap-1 border-b border-fw-border py-3" data-sidebar-nav-list>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <GlobalUiSettingsMenu variant="rail" menuAlign="start" menuSide="bottom" onOpenSetup={onSelectSetup} onOpenLogs={onSelectLogs} setupActive={setupActive} />
        <div className="my-1 h-px w-6 bg-fw-border" aria-hidden="true" />
        {onSelectArchitecture && <RailButton label="System" active={activeView === 'system'} onClick={onSelectArchitecture}><Network className="h-4 w-4" /></RailButton>}
        {onSelectTasks && <RailButton label="Tasks" active={activeView === 'tasks'} onClick={onSelectTasks}><ClipboardList className="h-4 w-4" aria-hidden="true" /></RailButton>}
        <RailButton label="Search history" active={activeView === 'search'} onClick={onSelectSearch}><Search className="h-4 w-4" /></RailButton>
      </div>

      {/* Session rail */}
      <div className="flex-1 flex flex-col items-center gap-1.5 py-2 overflow-y-auto w-full scrollbar-none">
        <button
          type="button"
          onClick={onCreateSession}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse transition"
          title="New session"
          aria-label="New session"
        >
          <Plus className="h-4 w-4" />
        </button>
        {rootSessions.slice(0, 20).map((session) => {
          const isActive = session.id === currentSession
          const initial = getSessionInitial(session)
          const runtimeState = getSessionRuntimeStateName(session)
          const activeRuntime = isSessionRuntimeActive(session)
          const showRuntimeIndicator = activeRuntime || runtimeState === 'waiting' || runtimeState === 'llm-failed' || !!session.runtimeState?.compaction
          const outcome = runtimeState === 'llm-failed' ? ` — ${getSessionRuntimeSummary(session)}` : ''
          const isUnread = unreadSessionIds.has(session.id)
          const tone = getSessionRuntimeTone(session)
          const indicatorColor = tone === 'muted' ? 'bg-fw-text-muted' : `bg-fw-${tone}`
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              title={`${session.displayName || session.id}${outcome}${isUnread ? ' — Unread idle completion' : ''}`}
              aria-label={`${session.displayName || session.id}${outcome}${isUnread ? ', Unread idle completion' : ''}`}
              className={`collapsed-session-tile relative flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition shrink-0 ${
                isActive
                  ? 'bg-fw-accent-surface text-fw-accent ring-1 ring-fw-focus-ring dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent dark:ring-fw-focus-ring'
                  : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text dark:hover:bg-fw-hover'
              }`}
            >
              {initial}
              {showRuntimeIndicator && (
                activeRuntime
                  ? <svg aria-hidden="true" data-runtime-perimeter viewBox="0 0 32 32" className={`collapsed-runtime-perimeter pointer-events-none absolute inset-0 h-full w-full ${tone === 'muted' ? 'text-fw-text-muted' : `text-fw-${tone}`}`}>
                      <rect className="collapsed-runtime-perimeter-segment" x="1" y="1" width="30" height="30" rx="7" pathLength="100" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                    </svg>
                  : <span aria-hidden="true" className={`absolute top-0.5 right-0.5 h-2 w-2 rounded-full ring-1 ring-fw-focus-ring dark:ring-fw-focus-ring ${indicatorColor}`} />
              )}
              {isUnread && <span aria-hidden="true" className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full bg-fw-accent ring-1 ring-fw-focus-ring dark:ring-fw-focus-ring" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function RailButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${active ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40' : 'text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong'}`}>
      {children}
    </button>
  )
}

import { History, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { BoundedSessionListPresentationProps, Session } from './SessionListCore'
import type { SessionIdleNotificationMode } from '../sessionIdleNotifications'
import CreateTabButton from './CreateTabButton'
import CodeLaunchButton from './CodeLaunchButton'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'
import AgentCreationMenu from './AgentCreationMenu'
import type { AgentSummary } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'

interface SessionListProps {
  sessions: Session[]
  agents: AgentSummary[]
  currentSession?: string
  currentView: 'session' | 'agents' | 'setup' | 'logs'
  currentSessionRecord?: Session
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectSearch: () => void
  onSelectSetup: () => void
  onSelectLogs?: () => void
  codePath: string
  codeNodeId: string
  codeOpenInNewWindow: boolean
  codeActive: boolean
  nodeTargets: readonly WebUiNodeTarget[]
  nodeTargetsError?: string
  onRefreshNodeTargets: () => void
  onOpenCode: (nodeId: string, path: string) => void
  onCodeNodeChange: (nodeId: string) => void
  onCodePathChange: (path: string) => void
  onCodeOpenInNewWindowChange: (enabled: boolean) => void
  onCreateTerminalTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateAgent: (agentId: string, inheritAgent?: string) => Promise<void>
  onCreateSession: (agentId: string, sessionId?: string) => Promise<void>
  idleNotificationModes: Record<string, SessionIdleNotificationMode>
  unreadSessionIds?: ReadonlySet<string>
  onToggleIdleNotificationMode: (sessionId: string, mode: SessionIdleNotificationMode) => void
  bounded?: BoundedSessionListPresentationProps
}

export default function SessionList({
  sessions,
  agents,
  currentSession,
  currentView,
  currentSessionRecord,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onSelectSearch,
  onSelectSetup,
  onSelectLogs,
  codePath,
  codeNodeId,
  codeOpenInNewWindow,
  codeActive,
  nodeTargets,
  nodeTargetsError,
  onRefreshNodeTargets,
  onOpenCode,
  onCodeNodeChange,
  onCodePathChange,
  onCodeOpenInNewWindowChange,
  onCreateTerminalTab,
  onCreateAgent,
  onCreateSession,
  idleNotificationModes,
  unreadSessionIds,
  onToggleIdleNotificationMode,
  bounded,
}: SessionListProps) {
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'

  const agentsBtnClass = currentView === 'agents'
    ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent'
    : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/70 dark:text-fw-text-strong dark:hover:bg-fw-hover'
  return (
    <div className="foxwarm-safe-area-shell foxwarm-fixed-viewport-shell fixed inset-x-0 bg-fw-canvas flex flex-col">
      <div className="p-4 border-b border-fw-border bg-fw-surface">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-bold text-fw-text-strong">🦊 Foxwarm</h1>
        </div>

        <div className="mt-2 flex items-stretch gap-1">
          <button
            onClick={onSelectArchitecture}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${agentsBtnClass}`}
          >
            <Workflow className="w-4 h-4" />
            <span>Agents</span>
          </button>
          <AgentCreationMenu
            agents={agents}
            currentAgent={currentSessionRecord?.agent}
            compact
            onCreateAgent={onCreateAgent}
            onCreateSession={onCreateSession}
          />
        </div>

        <div className="mt-2">
          <CodeLaunchButton
            path={codePath}
            nodeId={codeNodeId}
            nodeTargets={nodeTargets}
            nodeTargetsError={nodeTargetsError}
            openInNewWindow={codeOpenInNewWindow}
            active={codeActive}
            onOpen={onOpenCode}
            onNodeChange={onCodeNodeChange}
            onPathChange={onCodePathChange}
            onOpenInNewWindowChange={onCodeOpenInNewWindowChange}
            onRefreshNodeTargets={onRefreshNodeTargets}
          />
        </div>

        <div className="mt-2">
          <CreateTabButton
            defaultNodeId={defaultNodeId}
            defaultPath={defaultPath}
            onCreate={(options) => onCreateTerminalTab(options)}
            nodeTargets={nodeTargets}
            nodeTargetsError={nodeTargetsError}
            onRefreshNodeTargets={onRefreshNodeTargets}
          />
        </div>
      </div>
      
      <div className="flex-1 min-h-0 border-t border-fw-border">
        <SessionListCore
          sessions={sessions}
          currentSession={currentSession}
          onSelectSession={onSelectSession}
          onKeepSession={onKeepSession}
          idleNotificationModes={idleNotificationModes}
          unreadSessionIds={unreadSessionIds}
          onToggleIdleNotificationMode={onToggleIdleNotificationMode}
          bounded={bounded}
          dragEnabled={false}
          toolbarContainerClassName="mx-auto w-full max-w-4xl p-2 sm:p-4 sm:pb-2"
          listContainerClassName="mx-auto w-full max-w-4xl p-2 sm:p-4 sm:pt-1"
        />
      </div>
      <div data-sidebar-footer className="flex shrink-0 justify-end gap-1 border-t border-fw-border bg-fw-surface p-2">
        <button type="button" onClick={onSelectSearch} title="Search history" aria-label="Search history" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-fw-border text-fw-text transition hover:bg-fw-hover hover:text-fw-text-strong dark:border-fw-border dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse">
          <History className="h-4 w-4" />
        </button>
        <GlobalUiSettingsMenu menuSide="top" onOpenSetup={onSelectSetup} onOpenLogs={onSelectLogs} setupActive={currentView === 'setup'} />
      </div>
    </div>
  )
}

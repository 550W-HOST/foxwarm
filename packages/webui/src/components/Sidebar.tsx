import { PanelLeftClose, PanelLeftOpen, Search, Network, ClipboardList } from 'lucide-react'
import { SidebarNavItem } from './SidebarNav'
import SessionListCore from './SessionListCore'
import type { BoundedSessionListPresentationProps, Session } from './SessionListCore'
import type { SessionIdleNotificationMode } from '../sessionIdleNotifications'
import CreateTabButton from './CreateTabButton'
import CodeLaunchButton from './CodeLaunchButton'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'
import { useState } from 'react'
import AgentCreationMenu, { type SessionCreationRequest } from './AgentCreationMenu'
import type { AgentSettingsChanges, AgentSummary } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'

interface SidebarProps {
  sessions: Session[]
  agents: AgentSummary[]
  currentSession: string
  currentView: 'session' | 'agents' | 'setup' | 'logs' | 'tasks'
  currentSessionRecord?: Session
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onOpenAgentSettings?: (agent: string) => void
  onSelectSearch: () => void
  /** Opens message search prefilled with the session filter text. */
  onSearchMessages?: (query: string) => void
  /** Type of the focused workbench tab, for the active navigation row. */
  activeTabType?: string
  onSelectSetup: () => void
  onSelectLogs?: () => void
  onSelectTasks?: () => void
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
  onCreateAgent: (agentId: string, settings: AgentSettingsChanges) => Promise<void>
  onCreateSession: (agentId: string, sessionId?: string, runtime?: 'foxwarm' | 'claude-code', parentSessionId?: string) => Promise<void>
  onToggleCollapsed: () => void
  isPeek?: boolean
  idleNotificationModes: Record<string, SessionIdleNotificationMode>
  unreadSessionIds?: ReadonlySet<string>
  onToggleIdleNotificationMode: (sessionId: string, mode: SessionIdleNotificationMode) => void
  bounded?: BoundedSessionListPresentationProps
}

export default function Sidebar({
  sessions,
  agents,
  currentSession,
  currentView,
  currentSessionRecord,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onOpenAgentSettings,
  onSelectSearch,
  onSearchMessages,
  activeTabType,
  onSelectSetup,
  onSelectLogs,
  onSelectTasks,
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
  onToggleCollapsed,
  isPeek = false,
  idleNotificationModes,
  unreadSessionIds,
  onToggleIdleNotificationMode,
  bounded,
}: SidebarProps) {
  const [creationRequest, setCreationRequest] = useState<SessionCreationRequest | null>(null)
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'

  // Brand row with settings, then navigation rows (icon + text), then the Session list.
  return (
    <div className="foxwarm-sidebar-panel h-full bg-fw-sidebar-surface border-r border-fw-border flex flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3 border-b border-fw-border">
        <div className="mb-2 flex items-center justify-between gap-2 pl-1" data-sidebar-brand>
          <h1 className="text-xl font-bold text-fw-text-strong">🦊 Foxwarm</h1>
          <div className="flex items-center gap-1">
            <GlobalUiSettingsMenu
              menuAlign="end"
              menuSide="bottom"
              onOpenSetup={onSelectSetup} onOpenLogs={onSelectLogs}
              setupActive={currentView === 'setup' || currentView === 'logs'}
            />
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-fw-border bg-fw-surface-sunken text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:border-fw-border dark:bg-fw-surface dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse"
              title={isPeek ? 'Pin sidebar open' : 'Collapse sidebar'}
            >
              {isPeek ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <nav className="space-y-0.5" aria-label="Workspace" data-sidebar-nav-list>
          <SidebarNavItem icon={Network} label="System" active={currentView === 'agents'} onClick={onSelectArchitecture} title="Open System" dataNav="system" />
          {onSelectTasks && <SidebarNavItem icon={ClipboardList} label="Tasks" active={currentView === 'tasks'} onClick={onSelectTasks} dataNav="tasks" />}
          <SidebarNavItem icon={Search} label="Search" active={activeTabType === 'search'} onClick={onSelectSearch} title="Search history" dataNav="search" />
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
          <CreateTabButton
            variant="nav"
            defaultNodeId={defaultNodeId}
            defaultPath={defaultPath}
            onCreate={(options) => onCreateTerminalTab(options)}
            nodeTargets={nodeTargets}
            nodeTargetsError={nodeTargetsError}
            onRefreshNodeTargets={onRefreshNodeTargets}
          />
        </nav>
      </div>

      <div className="flex-1 min-h-0">
        <SessionListCore
          sessions={sessions}
          currentSession={currentSession}
          onSelectSession={onSelectSession}
          onKeepSession={onKeepSession}
          idleNotificationModes={idleNotificationModes}
          unreadSessionIds={unreadSessionIds}
          onToggleIdleNotificationMode={onToggleIdleNotificationMode}
          bounded={bounded}
          onRequestSession={setCreationRequest}
          onOpenAgentSettings={onOpenAgentSettings}
          onStartSession={() => { void onCreateSession('main').catch(error => window.alert(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`)) }}
          onSearchMessages={onSearchMessages}
          toolbarActions={
            <AgentCreationMenu
              agents={agents}
              currentAgent={currentSessionRecord?.agent}
              onCreateAgent={onCreateAgent}
              onCreateSession={onCreateSession}
              creationRequest={creationRequest}
              onCreationRequestHandled={() => setCreationRequest(null)}
              directCreate
              triggerClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-fw-border bg-fw-surface text-fw-text-muted transition hover:border-fw-accent-border hover:text-fw-accent focus:outline-none focus:ring-2 focus:ring-fw-focus-ring/30 dark:border-fw-border dark:bg-fw-canvas dark:text-fw-text"
              optionsTriggerClassName="inline-flex h-7 w-5 shrink-0 items-center justify-center rounded-lg border border-l-0 border-fw-border bg-fw-surface text-fw-text-muted transition hover:border-fw-accent-border hover:text-fw-accent focus:outline-none focus:ring-2 focus:ring-fw-focus-ring/30 dark:border-fw-border dark:bg-fw-canvas dark:text-fw-text"
            />
          }
          toolbarContainerClassName="p-2 pb-1"
          listContainerClassName="p-2 pt-1"
        />
      </div>
    </div>
  )
}

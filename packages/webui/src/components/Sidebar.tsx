import { PanelLeftClose, PanelLeftOpen, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { BoundedSessionListPresentationProps, Session } from './SessionListCore'
import type { SessionIdleNotificationMode } from '../sessionIdleNotifications'
import CreateTabButton from './CreateTabButton'
import CodeLaunchButton from './CodeLaunchButton'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'
import AgentCreationMenu from './AgentCreationMenu'
import type { AgentSummary } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'

interface SidebarProps {
  sessions: Session[]
  agents: AgentSummary[]
  currentSession: string
  currentView: 'session' | 'agents' | 'setup'
  currentSessionRecord?: Session
  sendKeyMode: 'modEnter' | 'enter'
  onSendKeyModeChange: (mode: 'modEnter' | 'enter') => void
  groupTools: boolean
  onGroupToolsChange: (enabled: boolean) => void
  showUsageBadge: boolean
  onShowUsageBadgeChange: (enabled: boolean) => void
  instanceName: string
  onInstanceNameChange: (name: string) => Promise<void> | void
  tabIcon: string
  onTabIconChange: (tabIcon: string) => Promise<void> | void
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectSetup: () => void
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
  sendKeyMode,
  onSendKeyModeChange,
  groupTools,
  onGroupToolsChange,
  showUsageBadge,
  onShowUsageBadgeChange,
  instanceName,
  onInstanceNameChange,
  tabIcon,
  onTabIconChange,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onSelectSetup,
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
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'

  const agentsBtnClass = currentView === 'agents'
    ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent'
    : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'
  return (
    <div className="h-full bg-fw-surface border-r border-fw-border flex flex-col">
      <div className="p-4 border-b border-fw-border space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-fw-text-strong">🦊 Foxwarm</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-fw-border bg-fw-surface-sunken text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:border-fw-border dark:bg-fw-surface dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse"
              title={isPeek ? 'Pin sidebar open' : 'Collapse sidebar'}
            >
              {isPeek ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <GlobalUiSettingsMenu
              sendKeyMode={sendKeyMode}
              onSendKeyModeChange={onSendKeyModeChange}
              groupTools={groupTools}
              onGroupToolsChange={onGroupToolsChange}
              showUsageBadge={showUsageBadge}
              onShowUsageBadgeChange={onShowUsageBadgeChange}
              instanceName={instanceName}
              onInstanceNameChange={onInstanceNameChange}
              tabIcon={tabIcon}
              onTabIconChange={onTabIconChange}
              menuAlign="end"
              onOpenSetup={onSelectSetup}
              setupActive={currentView === 'setup'}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-stretch gap-1">
            <button
              onClick={onSelectArchitecture}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${agentsBtnClass}`}
              title="Open agents overview"
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
          toolbarContainerClassName="p-2 pb-1"
          listContainerClassName="p-2 pt-1"
        />
      </div>
    </div>
  )
}

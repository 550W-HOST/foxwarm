import { Workflow } from 'lucide-react'
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
  currentView: 'session' | 'agents' | 'setup'
  currentSessionRecord?: Session
  themeMode: 'auto' | 'light' | 'dark'
  onThemeChange: (mode: 'auto' | 'light' | 'dark') => void
  uiThemeStyle: 'default' | '550a'
  onUiThemeStyleChange: (style: 'default' | '550a') => void
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
  themeMode,
  onThemeChange,
  uiThemeStyle,
  onUiThemeStyleChange,
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
  idleNotificationModes,
  unreadSessionIds,
  onToggleIdleNotificationMode,
  bounded,
}: SessionListProps) {
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'

  const agentsBtnClass = currentView === 'agents'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-700'
  return (
    <div className="foxwarm-safe-area-shell foxwarm-fixed-viewport-shell fixed inset-x-0 bg-gray-100 dark:bg-gray-900 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>
          <GlobalUiSettingsMenu
            themeMode={themeMode}
            onThemeChange={onThemeChange}
            uiThemeStyle={uiThemeStyle}
            onUiThemeStyleChange={onUiThemeStyleChange}
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
            onOpenSetup={onSelectSetup}
            setupActive={currentView === 'setup'}
          />
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
      
      <div className="flex-1 min-h-0 border-t border-gray-200 dark:border-gray-700">
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
    </div>
  )
}

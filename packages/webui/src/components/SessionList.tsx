import { Plus, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'
import CreateTabButton from './CreateTabButton'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'

interface SessionListProps {
  sessions: Session[]
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
  onCreateTerminalTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateSession: () => void
}

export default function SessionList({
  sessions,
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
  onCreateTerminalTab,
  onCreateSession,
}: SessionListProps) {
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'
  const sessionLabel = currentSessionRecord?.displayName || currentSession || 'main'

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
          <button
            onClick={onCreateSession}
            className="inline-flex items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-700"
            title="Create new session"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-2">
          <CreateTabButton
            defaultNodeId={defaultNodeId}
            defaultPath={defaultPath}
            sessionLabel={sessionLabel}
            onCreate={(options) => onCreateTerminalTab(options)}
          />
        </div>
      </div>
      
      <div className="flex-1 min-h-0 border-t border-gray-200 dark:border-gray-700">
        <SessionListCore
          sessions={sessions}
          currentSession={currentSession}
          onSelectSession={onSelectSession}
          onKeepSession={onKeepSession}
          toolbarContainerClassName="mx-auto w-full max-w-4xl p-2 sm:p-4 sm:pb-2"
          listContainerClassName="mx-auto w-full max-w-4xl p-2 sm:p-4 sm:pt-1"
        />
      </div>
    </div>
  )
}

import { PanelLeftClose, PanelLeftOpen, Plus, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'
import CreateTabButton from './CreateTabButton'
import GlobalUiSettingsMenu from './GlobalUiSettingsMenu'

interface SidebarProps {
  sessions: Session[]
  currentSession: string
  currentView: 'session' | 'agents' | 'setup'
  currentSessionRecord?: Session
  themeMode: 'auto' | 'light' | 'dark'
  onThemeChange: (mode: 'auto' | 'light' | 'dark') => void
  sendKeyMode: 'modEnter' | 'enter'
  onSendKeyModeChange: (mode: 'modEnter' | 'enter') => void
  groupTools: boolean
  onGroupToolsChange: (enabled: boolean) => void
  showUsageBadge: boolean
  onShowUsageBadgeChange: (enabled: boolean) => void
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectSetup: () => void
  onCreateWorkspaceTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateTerminalTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateSession: () => void
  onToggleCollapsed: () => void
  isPeek?: boolean
}

export default function Sidebar({
  sessions,
  currentSession,
  currentView,
  currentSessionRecord,
  themeMode,
  onThemeChange,
  sendKeyMode,
  onSendKeyModeChange,
  groupTools,
  onGroupToolsChange,
  showUsageBadge,
  onShowUsageBadgeChange,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onSelectSetup,
  onCreateWorkspaceTab,
  onCreateTerminalTab,
  onCreateSession,
  onToggleCollapsed,
  isPeek = false,
}: SidebarProps) {
  const defaultNodeId = currentSessionRecord?.currentNode || 'master'
  const defaultPath = currentSessionRecord?.cwd || '/'
  const sessionLabel = currentSessionRecord?.displayName || currentSession || 'main'

  const agentsBtnClass = currentView === 'agents'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
  return (
    <div className="h-full bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
              title={isPeek ? 'Pin sidebar open' : 'Collapse sidebar'}
            >
              {isPeek ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <GlobalUiSettingsMenu
              themeMode={themeMode}
              onThemeChange={onThemeChange}
              sendKeyMode={sendKeyMode}
              onSendKeyModeChange={onSendKeyModeChange}
              groupTools={groupTools}
              onGroupToolsChange={onGroupToolsChange}
              showUsageBadge={showUsageBadge}
              onShowUsageBadgeChange={onShowUsageBadgeChange}
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
            <button
              onClick={onCreateSession}
              className="inline-flex items-center justify-center rounded-lg px-2 transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Create new session"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <CreateTabButton
            kind="workspace"
            defaultNodeId={defaultNodeId}
            defaultPath={defaultPath}
            sessionLabel={sessionLabel}
            onCreate={(options) => onCreateWorkspaceTab(options)}
          />
          <CreateTabButton
            kind="terminal"
            defaultNodeId={defaultNodeId}
            defaultPath={defaultPath}
            sessionLabel={sessionLabel}
            onCreate={(options) => onCreateTerminalTab(options)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="border-t border-gray-200 dark:border-gray-700 p-2">
          <SessionListCore
            sessions={sessions}
            currentSession={currentSession}
            onSelectSession={onSelectSession}
            onKeepSession={onKeepSession}
          />
        </div>
      </div>
    </div>
  )
}

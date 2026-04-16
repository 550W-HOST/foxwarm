import { Plus, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'
import CreateTabButton from './CreateTabButton'

interface SessionListProps {
  sessions: Session[]
  currentSession?: string
  currentView: 'session' | 'agents'
  currentSessionRecord?: Session
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onCreateWorkspaceTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateTerminalTab: (options?: { nodeId?: string; path?: string }) => void
  onCreateSession: () => void
}

export default function SessionList({
  sessions,
  currentSession,
  currentView,
  currentSessionRecord,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onCreateWorkspaceTab,
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
    <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>

        <div className="mt-3 flex items-stretch gap-2">
          <button
            onClick={onSelectArchitecture}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${agentsBtnClass}`}
          >
            <Workflow className="w-4 h-4" />
            <span>Agents</span>
          </button>
          <button
            onClick={onCreateSession}
            className="inline-flex items-center justify-center rounded-xl px-3 text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-700"
            title="Create new session"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-2 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <CreateTabButton
              kind="workspace"
              defaultNodeId={defaultNodeId}
              defaultPath={defaultPath}
              sessionLabel={sessionLabel}
              onCreate={(options) => onCreateWorkspaceTab(options)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <CreateTabButton
              kind="terminal"
              defaultNodeId={defaultNodeId}
              defaultPath={defaultPath}
              sessionLabel={sessionLabel}
              onCreate={(options) => onCreateTerminalTab(options)}
            />
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="border-t border-gray-200 dark:border-gray-700 max-w-4xl mx-auto p-4">
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

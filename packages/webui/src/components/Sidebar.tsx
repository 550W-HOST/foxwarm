import { FolderOpen, Plus, SquareTerminal, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'

interface SidebarProps {
  sessions: Session[]
  currentSession: string
  currentView: 'chat' | 'architecture' | 'workspace' | 'terminal'
  onSelectSession: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectWorkspace: (sessionId?: string) => void
  onSelectTerminal: (sessionId?: string) => void
  onCreateSession: () => void
}

export default function Sidebar({
  sessions,
  currentSession,
  currentView,
  onSelectSession,
  onSelectArchitecture,
  onSelectWorkspace,
  onSelectTerminal,
  onCreateSession,
}: SidebarProps) {
  return (
    <div className="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>
          <button
            onClick={onCreateSession}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Create new session"
          >
            <Plus className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        <div className="space-y-2">
          <button
            onClick={onSelectArchitecture}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              currentView === 'architecture'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Open architecture overview"
          >
            <Workflow className="w-4 h-4" />
            <span>Architecture</span>
          </button>
          <button
            onClick={() => onSelectWorkspace(currentSession)}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              currentView === 'workspace'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Open workspace"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Workspace</span>
          </button>
          <button
            onClick={() => onSelectTerminal(currentSession)}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              currentView === 'terminal'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Open terminal"
          >
            <SquareTerminal className="w-4 h-4" />
            <span>Terminal</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="border-t border-gray-200 dark:border-gray-700 p-2">
          <SessionListCore
            sessions={sessions}
            currentSession={currentSession}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    </div>
  )
}

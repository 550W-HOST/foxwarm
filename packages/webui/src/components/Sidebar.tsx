import { GitBranch, MessageSquare, Plus } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'

interface SidebarProps {
  sessions: Session[]
  currentSession: string
  currentView: 'chat' | 'architecture'
  onSelectSession: (sessionId: string) => void
  onSelectArchitecture: () => void
  onCreateSession: () => void
}

export default function Sidebar({
  sessions,
  currentSession,
  currentView,
  onSelectSession,
  onSelectArchitecture,
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

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onSelectSession(currentSession)}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              currentView === 'chat'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Open current session"
          >
            <MessageSquare className="w-4 h-4" />
            <span>Chats</span>
          </button>
          <button
            onClick={onSelectArchitecture}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              currentView === 'architecture'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Open architecture overview"
          >
            <GitBranch className="w-4 h-4" />
            <span>Architecture</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="p-2">
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

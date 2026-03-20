import { FolderOpen, Plus, Workflow } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'

interface SessionListProps {
  sessions: Session[]
  currentSession?: string
  currentView: 'chat' | 'architecture' | 'workspace'
  onSelectSession: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectWorkspace: (sessionId?: string) => void
  onCreateSession: () => void
}

export default function SessionList({
  sessions,
  currentSession,
  currentView,
  onSelectSession,
  onSelectArchitecture,
  onSelectWorkspace,
  onCreateSession,
}: SessionListProps) {
  return (
    <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 flex flex-col">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">Select a session</p>
          </div>
          <button
            onClick={onCreateSession}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Create new session"
          >
            <Plus className="w-6 h-6 text-gray-600 dark:text-gray-400" />
          </button>
        </div>
        <button
          onClick={onSelectArchitecture}
          className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${
            currentView === 'architecture'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          <Workflow className="w-4 h-4" />
          <span>Architecture</span>
        </button>
        <button
          onClick={() => onSelectWorkspace(currentSession)}
          className={`mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${
            currentView === 'workspace'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/70 dark:text-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          <FolderOpen className="w-4 h-4" />
          <span>Workspace</span>
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="border-t border-gray-200 dark:border-gray-700 max-w-4xl mx-auto p-4">
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

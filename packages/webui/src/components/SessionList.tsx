import { Plus } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'

interface SessionListProps {
  sessions: Session[]
  currentSession?: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
}

export default function SessionList({ sessions, currentSession, onSelectSession, onCreateSession }: SessionListProps) {
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
      </div>
      
      <div className="flex-1 overflow-y-auto" data-session-list-scroll-container>
        <div className="max-w-4xl mx-auto p-4">
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

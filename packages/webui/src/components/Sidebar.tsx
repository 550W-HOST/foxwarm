import { Plus } from 'lucide-react'
import SessionListCore from './SessionListCore'
import type { Session } from './SessionListCore'

interface SidebarProps {
  sessions: Session[]
  currentSession: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
}

export default function Sidebar({ sessions, currentSession, onSelectSession, onCreateSession }: SidebarProps) {
  return (
    <div className="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <div className="h-20 px-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">🦊 Foxwarm</h1>
        <button
          onClick={onCreateSession}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Create new session"
        >
          <Plus className="w-5 h-5 text-gray-600 dark:text-gray-400" />
        </button>
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

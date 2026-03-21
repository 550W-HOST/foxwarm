import { FileText, FolderOpen, MessageSquareText, SquareTerminal, X } from 'lucide-react'

export type WorkbenchTab =
  | { id: string; type: 'chat'; title: string; sessionId: string }
  | { id: string; type: 'workspace'; title: string; sessionId: string; nodeId: string; path: string }
  | { id: string; type: 'file'; title: string; sessionId: string; nodeId: string; path: string }
  | { id: string; type: 'terminal'; title: string; sessionId: string; terminalId?: string; nodeId?: string; cwd?: string; createMode?: 'new' | 'reuse' }

interface WorkbenchTabsProps {
  tabs: WorkbenchTab[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}

function TabIcon({ type }: { type: WorkbenchTab['type'] }) {
  if (type === 'chat') return <MessageSquareText className="h-4 w-4 shrink-0" />
  if (type === 'workspace') return <FolderOpen className="h-4 w-4 shrink-0" />
  if (type === 'file') return <FileText className="h-4 w-4 shrink-0" />
  return <SquareTerminal className="h-4 w-4 shrink-0" />
}

export default function WorkbenchTabs({ tabs, activeTabId, onSelectTab, onCloseTab }: WorkbenchTabsProps) {
  return (
    <div className="border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex gap-2 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelectTab(tab.id)
                }
              }}
              className={`group flex min-w-0 max-w-[24rem] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${active ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/80 dark:bg-blue-900/30 dark:text-blue-200' : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200 dark:hover:bg-gray-700/70'}`}
              title={tab.title}
            >
              <TabIcon type={tab.type} />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseTab(tab.id)
                }}
                className="rounded p-0.5 text-gray-400 opacity-70 hover:bg-black/5 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-gray-200"
                title="Close tab"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
import { ClipboardList, Code2, FileText, MessageSquare, MoreHorizontal, Search, Settings, SquareTerminal, Workflow, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ContextMenu, { type ContextMenuAnchorRect, type ContextMenuEntry } from './ContextMenu'
import SessionListCore from './SessionListCore'
import type { BoundedSessionListPresentationProps, Session } from './SessionListCore'
import type { SessionIdleNotificationMode } from '../sessionIdleNotifications'
import CreateTabButton from './CreateTabButton'
import CodeLaunchButton from './CodeLaunchButton'
import AgentCreationMenu from './AgentCreationMenu'
import type { AgentSummary } from '../agentCreation'
import type { WebUiNodeTarget } from '../nodeTargets'

type HomeTab = 'sessions' | 'tasks' | 'search' | 'setup'
interface SessionListProps {
  renderPage: (tab: Exclude<HomeTab, 'sessions'>) => ReactNode
  sessions: Session[]
  agents: AgentSummary[]
  currentSession?: string
  currentView: 'session' | 'agents' | 'setup' | 'logs' | 'tasks' | 'nodes'
  currentSessionRecord?: Session
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
  onSelectArchitecture: () => void
  onSelectSearch: () => void
  onSelectSetup: () => void
  onSelectLogs?: () => void
  onSelectTasks?: () => void
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
  renderPage,
  sessions,
  agents,
  currentSession,
  currentSessionRecord,
  onSelectSession,
  onKeepSession,
  onSelectArchitecture,
  onSelectLogs,
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

  const [primaryTab, setPrimaryTab] = useState<HomeTab>('sessions')
  const [visited, setVisited] = useState<Set<HomeTab>>(() => new Set(['sessions']))
  const selectTab = (tab: HomeTab) => { setVisited(previous => new Set([...previous, tab])); setPrimaryTab(tab) }
  const homeTabs = [
    {id: 'sessions' as const, label: 'Sessions', icon: MessageSquare},
    {id: 'tasks' as const, label: 'Tasks', icon: ClipboardList},
    {id: 'search' as const, label: 'Search', icon: Search},
    {id: 'setup' as const, label: 'Settings', icon: Settings},
  ]
  const [moreAnchor, setMoreAnchor] = useState<ContextMenuAnchorRect | null>(null)
  const [utility, setUtility] = useState<'code' | 'terminal' | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (!utility) return
    const dialog = dialogRef.current!
    dialog.showModal()
    onRefreshNodeTargets()
    return () => { dialog.close(); if (moreRef.current?.isConnected) moreRef.current.focus() }
  }, [utility])

  const moreEntries: ContextMenuEntry[] = [
    { key: 'agents', label: 'Agents', icon: <Workflow size={16} />, onSelect: onSelectArchitecture },
    { key: 'code', label: 'Code', icon: <Code2 size={16} />, onSelect: () => setUtility('code') },
    { key: 'terminal', label: 'Terminal', icon: <SquareTerminal size={16} />, onSelect: () => setUtility('terminal') },
    ...(onSelectLogs ? [{ key: 'logs', label: 'Logs', icon: <FileText size={16} />, onSelect: onSelectLogs }] : []),
  ]
  const navClass = 'flex min-h-12 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-2 text-xs hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring'

  return (
    <div data-mobile-session-home className="foxwarm-safe-area-shell foxwarm-fixed-viewport-shell fixed inset-x-0 flex flex-col bg-fw-canvas">
      <section id="mobile-panel-sessions" role="tabpanel" aria-labelledby="mobile-tab-sessions" className="min-h-0 flex-1 flex-col" style={{display: primaryTab === 'sessions' ? 'flex' : 'none'}}>
      <ContextMenu open={!!moreAnchor} entries={moreEntries} anchorRect={moreAnchor} preferredPlacement="bottom-end"
        onClose={() => { setMoreAnchor(null); if (moreRef.current?.isConnected) moreRef.current.focus() }} />

      <div className="relative min-h-0 flex-1">
        <SessionListCore sessions={sessions} currentSession={currentSession} onSelectSession={onSelectSession} onKeepSession={onKeepSession}
          idleNotificationModes={idleNotificationModes} unreadSessionIds={unreadSessionIds} onToggleIdleNotificationMode={onToggleIdleNotificationMode}
          bounded={bounded} dragEnabled={false} mobileHeaderActions={(
        <button ref={moreRef} type="button" aria-label="Workspace tools" aria-haspopup="menu" aria-expanded={!!moreAnchor}
          onClick={() => setMoreAnchor(moreRef.current!.getBoundingClientRect())}
          className="mobile-header-circle">
          <MoreHorizontal className="h-5 w-5" />
        </button>

        )} toolbarContainerClassName="px-4 py-2" listContainerClassName="mobile-session-scroll px-4 pt-2" />
        <div className="absolute right-4 z-20" style={{bottom: 'calc(var(--foxwarm-safe-area-bottom) + 88px)'}}>
          <AgentCreationMenu agents={agents} currentAgent={currentSessionRecord?.agent} onCreateAgent={onCreateAgent} onCreateSession={onCreateSession}
            triggerLabel="New session" triggerClassName="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-fw-accent px-4 text-sm font-medium text-fw-accent-text shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring focus-visible:ring-offset-2" />
        </div>
      </div>
      </section>
      {homeTabs.filter(tab => tab.id !== 'sessions' && visited.has(tab.id)).map(tab => <section key={tab.id} id={`mobile-panel-${tab.id}`} role="tabpanel" aria-labelledby={`mobile-tab-${tab.id}`}
        className="mobile-primary-panel min-h-0 flex-1 flex-col overflow-hidden" style={{display: primaryTab === tab.id ? 'flex' : 'none'}}>{renderPage(tab.id as Exclude<HomeTab, 'sessions'>)}</section>)}
      <nav data-sidebar-footer role="tablist" aria-label="Main navigation" className="mobile-glass-surface mobile-primary-nav flex items-center gap-1 px-2 py-1.5"
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = homeTabs.findIndex(tab => tab.id === primaryTab)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4
          selectTab(homeTabs[next].id)
          document.getElementById(`mobile-tab-${homeTabs[next].id}`)?.focus()
        }}>
        {homeTabs.map(({id, label, icon: Icon}) => <button key={id} id={`mobile-tab-${id}`} type="button" role="tab" aria-selected={primaryTab === id} aria-controls={`mobile-panel-${id}`} tabIndex={primaryTab === id ? 0 : -1}
          onClick={() => selectTab(id)} className={`${navClass} ${primaryTab === id ? 'text-fw-accent' : 'text-fw-text-muted'}`}><Icon className="h-5 w-5" /><span>{label}</span></button>)}
      </nav>
      {utility && createPortal(
        <dialog ref={dialogRef} aria-labelledby="mobile-tool-title" onCancel={event => {event.preventDefault(); setUtility(null)}}
          onClick={event => {if (event.target === event.currentTarget) {const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setUtility(null)}}}
          className="m-auto max-h-[calc(var(--foxwarm-app-height,100dvh)-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-4 text-fw-text shadow-xl backdrop:bg-fw-overlay/40">
          <header className="mb-2 flex items-center justify-between gap-3"><h2 id="mobile-tool-title" className="text-base font-semibold text-fw-text-strong">{utility === 'code' ? 'Code' : 'Terminal'}</h2>
            <button type="button" onClick={() => setUtility(null)} aria-label="Close tools" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover"><X className="h-5 w-5" /></button></header>
          {utility === 'code' ? <CodeLaunchButton inlineOptions onCancel={() => setUtility(null)} path={codePath} nodeId={codeNodeId}
            nodeTargets={nodeTargets} nodeTargetsError={nodeTargetsError} openInNewWindow={codeOpenInNewWindow} active={codeActive}
            onOpen={(node, path) => {setUtility(null); onOpenCode(node, path)}} onNodeChange={onCodeNodeChange} onPathChange={onCodePathChange}
            onOpenInNewWindowChange={onCodeOpenInNewWindowChange} onRefreshNodeTargets={onRefreshNodeTargets} />
            : <CreateTabButton inlineOptions onCancel={() => setUtility(null)} defaultNodeId={defaultNodeId} defaultPath={defaultPath}
              onCreate={options => {setUtility(null); onCreateTerminalTab(options)}} nodeTargets={nodeTargets} nodeTargetsError={nodeTargetsError} onRefreshNodeTargets={onRefreshNodeTargets} />}
        </dialog>, document.body)}
    </div>
  )
}

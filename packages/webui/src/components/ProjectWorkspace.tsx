import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bot, ChevronDown, ChevronRight, Code2, Folder, FolderPlus, History, Layers, Plus, RefreshCw, Server, Settings, SquareTerminal, X } from 'lucide-react'
import { getNodeTargetAvailability, type WebUiNodeTarget } from '../nodeTargets'
import { projectApi, type Project, type ProjectSession, type ProjectTab, type ProjectTabType } from '../projectWorkspace'

export interface ProjectTabActions {
  addTab: (type: ProjectTabType) => Promise<void>
}
export interface UnassignedCandidate {
  id: string
  displayName?: string
  currentNode?: string
  cwd?: string | null
}
export interface ProjectWorkspaceProps {
  nodeTargets: readonly WebUiNodeTarget[]
  onOpenSetup: () => void
  onOpenAgents: () => void
  onOpenNodes: () => void
  onOpenHistory: () => void
  unassignedCandidates?: readonly UnassignedCandidate[]
  onOpenUnassigned?: (sessionId: string) => void
  onLoadMoreUnassigned?: () => void
  auxiliaryTabs?: readonly { id: string; title: string; type: string }[]
  activeAuxiliaryTabId?: string | null
  onSelectAuxiliaryTab?: (id: string | null) => void
  onCloseAuxiliaryTab?: (id: string) => void
  renderAuxiliaryTab?: (id: string, active: boolean) => ReactNode
  renderAgent: (tab: ProjectTab, project: Project, active: boolean, actions: ProjectTabActions) => ReactNode
  renderTerminal: (tab: ProjectTab, project: Project, active: boolean, onTerminalReady: (terminalId: string) => void) => ReactNode
  renderCode: (tab: ProjectTab, project: Project, active: boolean) => ReactNode
  onCloseTerminal: (tab: ProjectTab) => Promise<void>
}

const SELECTED_SESSION_KEY = 'foxwarm_project_active_session_v1'
const SELECTED_TABS_KEY = 'foxwarm_project_active_tabs_v1'
const TERMINAL_IDS_KEY = 'foxwarm_project_terminal_ids_v1'

function readSelectedSession(): string {
  try { return localStorage.getItem(SELECTED_SESSION_KEY) || '' } catch { return '' }
}
function readStringMap(key: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string')) : {}
  } catch { return {} }
}
function persist(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* Browser storage is optional. */ } }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function newRequestId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}` }
const iconByType = { agent: Bot, terminal: SquareTerminal, code: Code2 }
const auxiliaryIconByType = { setup: Settings, agents: Layers, nodes: Server, search: History, chat: Bot, vscode: Code2, terminal: SquareTerminal }

export default function ProjectWorkspace({ nodeTargets, onOpenSetup, onOpenAgents, onOpenNodes, onOpenHistory, unassignedCandidates = [], onOpenUnassigned, onLoadMoreUnassigned, auxiliaryTabs = [], activeAuxiliaryTabId, onSelectAuxiliaryTab, onCloseAuxiliaryTab, renderAuxiliaryTab, renderAgent, renderTerminal, renderCode, onCloseTerminal }: ProjectWorkspaceProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState(readSelectedSession)
  const [selectedTabs, setSelectedTabs] = useState(() => readStringMap(SELECTED_TABS_KEY))
  const [terminalIds, setTerminalIds] = useState(() => readStringMap(TERMINAL_IDS_KEY))
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNode, setNewNode] = useState('master')
  const [newPath, setNewPath] = useState('')
  const [directories, setDirectories] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const refreshSerial = useRef(0)
  const pendingIds = useRef<Record<string, string>>({})

  const reload = useCallback(async () => {
    const serial = ++refreshSerial.current
    try {
      let offset: number | null = 0
      const loaded: Project[] = []
      while (offset !== null) {
        const result = await projectApi.list(offset)
        loaded.push(...result.projects)
        offset = result.nextOffset
        if (loaded.length >= 10000) throw new Error('Too many projects to display.')
      }
      if (serial !== refreshSerial.current) return
      setProjects(loaded)
      setError('')
    } catch (cause) {
      if (serial === refreshSerial.current) setError(message(cause))
    } finally {
      if (serial === refreshSerial.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { persist(SELECTED_SESSION_KEY, selectedSessionId) }, [selectedSessionId])
  useEffect(() => { persist(SELECTED_TABS_KEY, JSON.stringify(selectedTabs)) }, [selectedTabs])
  useEffect(() => { persist(TERMINAL_IDS_KEY, JSON.stringify(terminalIds)) }, [terminalIds])

  const visibleProjects = projects.filter(project => !project.archived)
  const flat = visibleProjects.flatMap(project => (project.sessions || []).filter(session => !session.archived).map(session => ({ project, session })))
  // Archived items leave navigation, but previously opened views remain mounted:
  // archiving must not discard editor drafts or tear down a live terminal.
  const retained = projects.flatMap(project => (project.sessions || []).map(session => ({ project, session })))
  const assignedIds = new Set(retained.flatMap(({ session }) => session.tabs.flatMap(tab => tab.type === 'agent' && tab.resourceId ? [tab.resourceId] : [])))
  const unassigned = unassignedCandidates.filter(session => !assignedIds.has(session.id))
  const selection = flat.find(item => item.session.id === selectedSessionId) || null
  const auxiliaryActive = auxiliaryTabs.some(tab => tab.id === activeAuxiliaryTabId)
  const activeTabId = selection ? (selection.session.tabs.find(tab => tab.id === selectedTabs[selection.session.id])?.id || selection.session.tabs[0]?.id || '') : ''
  useEffect(() => {
    if (!loading && selectedSessionId && !flat.some(item => item.session.id === selectedSessionId)) setSelectedSessionId('')
  }, [loading, projects, selectedSessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTabId) setVisited(previous => previous.has(activeTabId) ? previous : new Set(previous).add(activeTabId))
  }, [activeTabId])
  useEffect(() => {
    if (selection) setExpanded(previous => previous.has(selection.project.id) ? previous : new Set(previous).add(selection.project.id))
  }, [selection?.project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setShowMenu(false) }, [activeAuxiliaryTabId])

  const selectSession = (projectId: string, sessionId: string) => {
    onSelectAuxiliaryTab?.(null)
    setExpanded(previous => new Set(previous).add(projectId))
    setSelectedSessionId(sessionId)
    setShowMenu(false)
    if (window.innerWidth < 768) setSidebarOpen(false)
  }
  const selectTab = (sessionId: string, tabId: string) => {
    onSelectAuxiliaryTab?.(null)
    setSelectedTabs(previous => ({ ...previous, [sessionId]: tabId }))
    setVisited(previous => new Set(previous).add(tabId))
    setShowMenu(false)
  }
  const addTab = async (project: Project, session: ProjectSession, type: ProjectTabType) => {
    const target = nodeTargets.find(node => node.id === project.nodeId)
    if (type !== 'agent' && target) {
      const status = getNodeTargetAvailability(target, type === 'code' ? 'vscode-fs' : 'vscode-pty')
      if (!status.available) { setError(status.reason || 'Node unavailable'); return }
    }
    if (type === 'code') {
      const existing = session.tabs.find(tab => tab.type === 'code')
      if (existing) { selectTab(session.id, existing.id); return }
    }
    const key = `${session.id}:${type}`
    const requestId = pendingIds.current[key] || (pendingIds.current[key] = newRequestId())
    setBusy(true)
    try {
      const result = await projectApi.createTab(session.id, { type, requestId })
      delete pendingIds.current[key]
      await reload()
      selectTab(session.id, result.tab.id)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const createSession = async (project: Project) => {
    const title = window.prompt('Work session name', 'New session')
    if (title === null) return
    setBusy(true)
    try {
      const result = await projectApi.createSession(project.id, title.trim() || 'New session')
      await reload()
      selectSession(project.id, result.session.id)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const attachExisting = async (session: ProjectSession, existingSessionId: string) => {
    setBusy(true)
    try {
      const result = await projectApi.createTab(session.id, { type: 'agent', existingSessionId, requestId: newRequestId() })
      await reload()
      selectTab(session.id, result.tab.id)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const attachSession = async (session: ProjectSession) => {
    const existingSessionId = window.prompt('Existing Foxwarm session ID (must already use this project’s node and directory)')
    if (existingSessionId?.trim()) await attachExisting(session, existingSessionId.trim())
  }
  const retryPending = async (session: ProjectSession, tab: ProjectTab) => {
    if (!tab.requestId) { setError('This incomplete tab has no request ID and cannot be retried.'); return }
    setBusy(true)
    try { await projectApi.createTab(session.id, { type: 'agent', requestId: tab.requestId }); await reload() }
    catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await projectApi.create({ name: newName.trim() || undefined, nodeId: newNode, rootPath: newPath.trim() || undefined })
      const project = result.project
      const existing = (project.sessions || []).find(session => !session.archived)
      const session = existing || (await projectApi.createSession(project.id, 'New session')).session
      await reload()
      selectSession(project.id, session.id)
      setDialog(false)
      setNewName('')
      setNewPath('')
      setDirectories(null)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const browse = async (path: string) => {
    setBusy(true)
    try {
      const result = await projectApi.directories(newNode, path)
      setNewPath(path)
      setDirectories(result.entries.filter(entry => (entry.type & 2) !== 0).map(entry => entry.name).sort((a, b) => a.localeCompare(b)))
      setError('')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const resolvePath = async () => {
    setBusy(true)
    try {
      const result = await projectApi.resolveDirectory(newNode, newPath.trim() || undefined)
      setNewPath(result.rootPath)
      setDirectories(null)
      setError('')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const renameProject = async (project: Project) => {
    const name = window.prompt('Project name', project.name)
    if (name === null || !name.trim() || name.trim() === project.name) return
    try { await projectApi.update(project.id, { name: name.trim() }); await reload() } catch (cause) { setError(message(cause)) }
  }
  const renameSession = async (session: ProjectSession) => {
    const title = window.prompt('Work session name', session.title)
    if (title === null || !title.trim() || title.trim() === session.title) return
    try { await projectApi.updateSession(session.id, { title: title.trim() }); await reload() } catch (cause) { setError(message(cause)) }
  }
  const archiveProject = async (project: Project) => {
    if (!window.confirm(`Archive ${project.name}? Its files and conversations will remain.`)) return
    try { await projectApi.update(project.id, { archived: true }); await reload() } catch (cause) { setError(message(cause)) }
  }
  const archiveSession = async (session: ProjectSession) => {
    if (!window.confirm(`Archive ${session.title}? Its files and conversations will remain.`)) return
    try { await projectApi.updateSession(session.id, { archived: true }); await reload() } catch (cause) { setError(message(cause)) }
  }
  const closeTab = async (session: ProjectSession, tab: ProjectTab) => {
    if (tab.type === 'terminal' && tab.resourceId && !window.confirm('Close this tab and end its terminal?')) return
    if (tab.type === 'code' && !window.confirm('Close Code? Save any unsaved files first.')) return
    setBusy(true)
    try {
      if (tab.type === 'terminal' && tab.resourceId) await onCloseTerminal(tab)
      await projectApi.deleteTab(tab.id)
      setVisited(previous => { const next = new Set(previous); next.delete(tab.id); return next })
      setTerminalIds(previous => { const next = { ...previous }; delete next[tab.id]; return next })
      setSelectedTabs(previous => previous[session.id] === tab.id ? { ...previous, [session.id]: '' } : previous)
      await reload()
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const saveTerminalId = (tab: ProjectTab, terminalId: string) => {
    if (!terminalId || tab.resourceId === terminalId) return
    // Record the PTY before the network write so a reload during a transient
    // failure reconnects to it instead of silently starting another process.
    setTerminalIds(previous => {
      const next = { ...previous, [tab.id]: terminalId }
      persist(TERMINAL_IDS_KEY, JSON.stringify(next))
      return next
    })
    void projectApi.updateTab(tab.id, { resourceId: terminalId }).then(reload).catch(cause => setError(message(cause)))
  }
  const iconButton = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong'

  return <div className="flex h-full min-h-0 w-full bg-fw-canvas text-fw-text" data-project-workspace>
    <aside className={`${sidebarOpen ? 'flex' : 'hidden'} w-64 shrink-0 flex-col border-r border-fw-border bg-fw-sidebar-surface max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl`}>
      <div className="flex items-center justify-between border-b border-fw-border p-4"><strong className="text-lg text-fw-text-strong">🦊 Foxwarm</strong><button className={iconButton} onClick={() => setSidebarOpen(false)} aria-label="Hide sidebar"><X size={16} /></button></div>
      <div className="space-y-1 border-b border-fw-border p-2">
        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-fw-hover" onClick={() => { setDialog(true); setError('') }}><FolderPlus size={16} /> New project</button>
        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-fw-hover" onClick={onOpenHistory}><History size={16} /> History</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Projects">
        {loading ? <p className="p-2 text-sm text-fw-text-muted">Loading projects…</p> : null}
        {!loading && !visibleProjects.length ? <p className="p-2 text-sm text-fw-text-muted">Create a project to begin.</p> : null}
        {visibleProjects.map(project => {
          const isExpanded = expanded.has(project.id)
          return <div key={project.id} className="mb-2">
            <div className="group flex items-center gap-1">
              <button type="button" onClick={() => setExpanded(previous => { const next = new Set(previous); if (isExpanded) next.delete(project.id); else next.add(project.id); return next })} className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-2 text-left text-sm hover:bg-fw-hover" aria-expanded={isExpanded}>
                {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<Folder size={15} /><span className="truncate font-medium">{project.name}</span>
              </button>
              <button type="button" className={iconButton} onClick={() => void createSession(project)} aria-label={`New session in ${project.name}`} title="New session"><Plus size={15} /></button>
              <button type="button" className={iconButton} onClick={() => void renameProject(project)} aria-label={`Rename ${project.name}`} title="Rename project">⋯</button>
              <button type="button" className={iconButton} onClick={() => void archiveProject(project)} aria-label={`Archive ${project.name}`} title="Archive project">×</button>
            </div>
            {isExpanded ? <div className="ml-3 border-l border-fw-border pl-2">
              {(project.sessions || []).filter(session => !session.archived).map(session => <div key={session.id} className={`group flex items-center rounded-lg ${session.id === selectedSessionId ? 'bg-fw-accent-surface text-fw-accent' : 'hover:bg-fw-hover'}`}>
                <button type="button" onClick={() => selectSession(project.id, session.id)} className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm">{session.title}</button>
                <button type="button" className={iconButton} onClick={() => void renameSession(session)} title="Rename session" aria-label={`Rename ${session.title}`}>⋯</button>
                <button type="button" className={iconButton} onClick={() => void archiveSession(session)} title="Archive session" aria-label={`Archive ${session.title}`}>×</button>
              </div>)}
            </div> : null}
          </div>
        })}
        {onOpenUnassigned ? <div className="mt-4 border-t border-fw-border pt-3" aria-label="Unassigned conversations">
          <p className="px-2 pb-1 text-xs font-medium text-fw-text-muted">Unassigned</p>
          {unassigned.map(session => <div key={session.id} className="flex items-center rounded-lg hover:bg-fw-hover">
            <button type="button" onClick={() => onOpenUnassigned(session.id)} className="min-w-0 flex-1 px-2 py-2 text-left" title={session.id}>
              <span className="block truncate text-sm">{session.displayName || session.id}</span>
              <span className="block truncate text-xs text-fw-text-muted">{session.currentNode || 'master'}{session.cwd ? ` · ${session.cwd}` : ''}</span>
            </button>
            {selection ? <button type="button" disabled={busy} onClick={() => void attachExisting(selection.session, session.id)} className={iconButton} aria-label={`Add ${session.displayName || session.id} to current work session`} title="Add to current work session"><Plus size={15} /></button> : null}
          </div>)}
          {!unassigned.length ? <p className="px-2 py-1 text-xs text-fw-text-muted">No loaded conversations.</p> : null}
          {onLoadMoreUnassigned ? <button type="button" onClick={onLoadMoreUnassigned} className="px-2 py-2 text-xs text-fw-accent">Load more conversations</button> : null}
        </div> : null}
      </div>
      <footer className="flex items-center gap-1 border-t border-fw-border p-2">
        <button type="button" className={iconButton} onClick={onOpenAgents} aria-label="Agents" title="Agents"><Layers size={16} /></button>
        <button type="button" className={iconButton} onClick={onOpenNodes} aria-label="Nodes" title="Nodes"><Server size={16} /></button>
        <button type="button" className={iconButton} onClick={() => void reload()} aria-label="Refresh projects" title="Refresh projects"><RefreshCw size={16} /></button>
        <button type="button" className={`${iconButton} ml-auto`} onClick={onOpenSetup} aria-label="Settings" title="Settings"><Settings size={16} /></button>
      </footer>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-fw-border px-3">
        {!sidebarOpen ? <button type="button" onClick={() => setSidebarOpen(true)} className={iconButton} aria-label="Show projects"><Folder size={16} /></button> : null}
        {selection ? <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-fw-text-strong">{selection.project.name} / {selection.session.title}</div><div className="truncate text-xs text-fw-text-muted" title={`${selection.project.nodeId}: ${selection.project.rootPath}`}>{selection.project.nodeId} · {selection.project.rootPath}</div></div> : <span className="min-w-0 flex-1 text-sm text-fw-text-muted">Select a work session</span>}
        {auxiliaryActive ? <button type="button" onClick={() => onSelectAuxiliaryTab?.(null)} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-fw-border px-2 py-1.5 text-sm hover:bg-fw-hover"><ArrowLeft size={15} />{selection ? 'Back to work session' : 'Back to projects'}</button> : null}
      </header>
      {error ? <div role="alert" className="flex items-center justify-between gap-2 border-b border-fw-border bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div> : null}
      {selection || auxiliaryTabs.length ? <div className="flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-fw-border px-2" role="tablist" aria-label="Work session tabs">
        {selection ? <>
        {selection.session.tabs.map(tab => { const Icon = iconByType[tab.type]; const effectiveTab = tab.type === 'terminal' && !tab.resourceId && terminalIds[tab.id] ? { ...tab, resourceId: terminalIds[tab.id] } : tab; const selected = !auxiliaryActive && activeTabId === tab.id; return <div key={tab.id} className={`flex shrink-0 items-center rounded-md ${selected ? 'bg-fw-accent-surface text-fw-accent' : 'hover:bg-fw-hover'}`}>
          <button type="button" role="tab" aria-selected={selected} onClick={() => selectTab(selection.session.id, tab.id)} className="flex max-w-48 items-center gap-2 truncate px-3 py-2 text-sm"><Icon size={15} /><span className="truncate">{tab.title || tab.type}</span></button>
          <button type="button" disabled={busy} onClick={() => void closeTab(selection.session, effectiveTab)} className="mr-1 rounded p-1 hover:bg-fw-hover" aria-label={`Close ${tab.title || tab.type}`}><X size={14} /></button>
        </div> })}
        <div className="relative shrink-0"><button type="button" disabled={busy} onClick={() => setShowMenu(!showMenu)} aria-label="New tab" aria-expanded={showMenu} className={iconButton}><Plus size={17} /></button>
          {showMenu ? <div className="fixed z-50 w-48 rounded-lg border border-fw-border bg-fw-surface p-1 shadow-lg" role="menu">{(['agent', 'terminal', 'code'] as const).map(type => { const Icon = iconByType[type]; return <button key={type} role="menuitem" type="button" onClick={() => void addTab(selection.project, selection.session, type)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm capitalize hover:bg-fw-hover"><Icon size={15} />{type}</button> })}<button role="menuitem" type="button" onClick={() => { setShowMenu(false); void attachSession(selection.session) }} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-fw-hover"><Bot size={15} /> Existing conversation</button></div> : null}
        </div>
        </> : null}
        {selection && auxiliaryTabs.length ? <span className="mx-1 h-5 shrink-0 border-l border-fw-border" aria-hidden="true" /> : null}
        {auxiliaryTabs.map(tab => { const Icon = auxiliaryIconByType[tab.type as keyof typeof auxiliaryIconByType] || Layers; const selected = tab.id === activeAuxiliaryTabId; return <div key={tab.id} className={`flex shrink-0 items-center rounded-md ${selected ? 'bg-fw-accent-surface text-fw-accent' : 'hover:bg-fw-hover'}`} data-project-auxiliary-tab={tab.id}>
          <button type="button" role="tab" aria-selected={selected} onClick={() => onSelectAuxiliaryTab?.(tab.id)} className="flex max-w-48 items-center gap-2 truncate px-3 py-2 text-sm"><Icon size={15} /><span className="truncate">{tab.title}</span></button>
          <button type="button" onClick={() => onCloseAuxiliaryTab?.(tab.id)} className="mr-1 rounded p-1 hover:bg-fw-hover" aria-label={`Close ${tab.title}`}><X size={14} /></button>
        </div> })}
      </div> : null}
      <div className="relative min-h-0 flex-1">
        {selection && !auxiliaryActive && !selection.session.tabs.length ? <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fw-text-muted"><p>This work session has no tabs yet.</p><button type="button" disabled={busy} onClick={() => void addTab(selection.project, selection.session, 'agent')} className="rounded-lg bg-fw-accent px-3 py-2 text-fw-accent-text">New Agent tab</button></div> : null}
        {retained.flatMap(({ project, session }) => session.tabs.filter(tab => visited.has(tab.id)).map(tab => {
          const active = !auxiliaryActive && selection?.session.id === session.id && activeTabId === tab.id
          const actions: ProjectTabActions = { addTab: type => addTab(project, session, type) }
          const effectiveTab = tab.type === 'terminal' && !tab.resourceId && terminalIds[tab.id] ? { ...tab, resourceId: terminalIds[tab.id] } : tab
          return <div key={tab.id} className="absolute inset-0 min-h-0" hidden={!active} aria-hidden={!active}>
            {tab.type === 'agent' && (tab.state === 'pending' || !tab.resourceId) ? <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fw-text-muted"><p>This Agent tab is not ready.</p><button type="button" disabled={busy} onClick={() => void retryPending(session, tab)} className="rounded-lg bg-fw-accent px-3 py-2 text-fw-accent-text">Retry setup</button></div> : tab.type === 'agent' ? renderAgent(tab, project, active, actions) : tab.type === 'terminal' ? renderTerminal(effectiveTab, project, active, terminalId => saveTerminalId(tab, terminalId)) : renderCode(tab, project, active)}
          </div>
        }))}
        {auxiliaryTabs.map(tab => {
          const active = tab.id === activeAuxiliaryTabId
          return <div key={tab.id} className="absolute inset-0 min-h-0" hidden={!active} aria-hidden={!active} data-project-auxiliary-content={tab.id}>{renderAuxiliaryTab?.(tab.id, active)}</div>
        })}
      </div>
    </main>
    {dialog ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation"><form onSubmit={event => void createProject(event)} role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-5 shadow-xl">
      <h2 id="new-project-title" className="text-lg font-semibold text-fw-text-strong">New project</h2>
      <p className="mt-1 text-sm text-fw-text-muted">Select a server and directory. Leave the path empty to use the server's default directory.</p>
      <label className="mt-4 block text-sm">Name <input value={newName} onChange={event => setNewName(event.target.value)} placeholder="Optional" className="mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2" /></label>
      <label className="mt-3 block text-sm">Node <select value={newNode} onChange={event => { setNewNode(event.target.value); setDirectories(null) }} className="mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2">{nodeTargets.map(node => <option key={node.id} value={node.id}>{node.displayName}{node.online ? '' : ' (offline)'}</option>)}</select></label>
      <label className="mt-3 block text-sm">Absolute directory <div className="mt-1 flex gap-2"><input value={newPath} onChange={event => { setNewPath(event.target.value); setDirectories(null) }} placeholder="Use node default" className="min-w-0 flex-1 rounded-lg border border-fw-border bg-fw-canvas px-3 py-2" /><button type="button" disabled={busy} onClick={() => void resolvePath()} className="rounded-lg border border-fw-border px-3 hover:bg-fw-hover">Resolve</button><button type="button" disabled={busy} onClick={() => void browse(newPath.startsWith('/') ? newPath : '/')} className="rounded-lg border border-fw-border px-3 hover:bg-fw-hover">Browse</button></div></label>
      {directories ? <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-fw-border p-1"><button type="button" onClick={() => void browse(newPath.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/')} className="block w-full rounded p-2 text-left text-sm hover:bg-fw-hover">..</button>{directories.map(name => <button type="button" key={name} onClick={() => void browse(`${newPath.replace(/\/+$/, '')}/${name}`)} className="block w-full truncate rounded p-2 text-left text-sm hover:bg-fw-hover">📁 {name}</button>)}</div> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-fw-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDialog(false)} className="rounded-lg border border-fw-border px-3 py-2">Cancel</button><button type="submit" disabled={busy} className="rounded-lg bg-fw-accent px-3 py-2 text-fw-accent-text disabled:opacity-50">{busy ? 'Creating…' : 'Create project'}</button></div>
    </form></div> : null}
  </div>
}

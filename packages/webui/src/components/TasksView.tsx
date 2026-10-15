import { createPortal } from 'react-dom'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ClipboardList, Copy, X, Plus, RefreshCw, List, Columns3, SlidersHorizontal, Search, ChevronDown } from 'lucide-react'
import { makeApiUrl } from '../config'
import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import SessionSelector from './SessionSelector'
import { TaskStatusBadge, TASK_STATUS_LABELS as STATUS_LABELS } from './StatusBadge'
import './TasksView.css'
import { copyTextToClipboard } from './chatShared'

const STATUSES = ['open', 'active', 'completed', 'cancelled'] as const
type TaskStatus = typeof STATUSES[number]
const LIST_LIMIT = 50
const TASK_SCOPES = ['work', 'all', 'history'] as const
const TASK_SCOPE_LABELS = { work: 'Work', all: 'All', history: 'History' } as const
const TASK_SCOPE_STATUSES: Record<'work' | 'all' | 'history', readonly TaskStatus[]> = {
  work: ['open', 'active'],
  all: STATUSES,
  history: ['completed', 'cancelled'],
} as const
const AGENT_RELATIONS = ['ownerOrCreator', 'owner', 'creator'] as const
const AGENT_RELATION_LABELS = {
  ownerOrCreator: 'Owner or Created by',
  owner: 'Owner',
  creator: 'Created by',
} as const

type TaskSummary = {
  id: string
  title: string
  status: typeof STATUSES[number]
  parentTaskId: string | null
  ownerSessionId: string | null
  ownerAgent?: string | null
  createdByKind?: 'session' | 'user'
  createdBySessionId: string | null
  createdByAgent?: string | null
  updatedAt: number
}
type TaskAuthor = { authorKind: 'session' | 'user'; sessionId: string | null }
type TaskList = { tasks: TaskSummary[]; total: number; omitted: number }
type TaskDetails = {
  task: TaskSummary & { description: string | null; result: string | null }
  children: { id: string; title: string; status: typeof STATUSES[number]; ownerSessionId: string | null }[]
  childrenOmitted: number
  notes: (TaskAuthor & { text: string; createdAt: number })[]
  notesOmitted: number
}
type TaskWriteResult = { task: TaskSummary; warning?: string }
type TaskScope = typeof TASK_SCOPES[number]

const LAST_TASK_OWNER_KEY = 'foxwarm_tasks_last_owner_v1'
const readLastTaskOwner = (): string | null => {
  try {
    const value = localStorage.getItem(LAST_TASK_OWNER_KEY)
    return value?.trim() || null
  } catch {
    return null
  }
}
const writeLastTaskOwner = (value: string | null) => {
  try {
    if (value) localStorage.setItem(LAST_TASK_OWNER_KEY, value)
    else localStorage.removeItem(LAST_TASK_OWNER_KEY)
  } catch {}
}

async function readTasks<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to load tasks.')
  return data as T
}

async function writeTask<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(makeApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Unable to update task.')
  return data as T
}

const formatTime = (value: number) => new Date(value).toLocaleString()
const buttonClass = 'task-button'
const SessionNames = createContext<Record<string, string>>({})
const relativeTime = (value: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const compactSessionLabel = (sessionId: string, agent?: string | null) => {
  const parts = sessionId.split('/').filter(Boolean)
  const leaf = parts[parts.length - 1] || sessionId
  const prefix = agent || parts.slice(0, -1).join('/')
  return prefix && prefix !== leaf ? `${prefix}/${leaf}` : leaf
}

function SessionReference({ sessionId, agent, compact = true, onOpenSession }: { sessionId: string; agent?: string | null; compact?: boolean; onOpenSession?: (sessionId: string) => void }) {
  const names = useContext(SessionNames)
  const label = compact ? names[sessionId] || compactSessionLabel(sessionId, agent) : sessionId
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    setCopyState('idle')
    return () => {
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
    }
  }, [sessionId])

  const copySessionId = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setCopyState('idle')
    try {
      await copyTextToClipboard(sessionId)
      setCopyState('copied')
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopyState('idle')
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy Session ID:', error)
      setCopyState('error')
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopyState('idle')
        copyResetTimeoutRef.current = null
      }, 3000)
    }
  }

  const copyLabel = copyState === 'copied'
    ? `Copied Session ID ${sessionId}`
    : copyState === 'error'
      ? `Copy failed for Session ID ${sessionId}`
      : `Copy Session ID ${sessionId}`

  return <span data-session-reference={sessionId} className="inline-flex min-w-0 max-w-full items-center gap-1 align-middle" title={sessionId}>
    {onOpenSession ? <button type="button" data-session-open={sessionId} className="min-w-0 truncate text-left text-fw-accent hover:underline" onClick={event => { event.stopPropagation(); onOpenSession(sessionId) }} aria-label={`Open Session ${sessionId}`}>{label}</button> : <span className="min-w-0 truncate">{label}</span>}
    <button type="button" data-session-copy={sessionId} data-session-copy-state={copyState} className="task-session-copy shrink-0 rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-focus-ring" title={copyLabel} aria-label={copyLabel} onClick={copySessionId}>
      {copyState === 'copied' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
    {copyState === 'error' && <span data-session-copy-error role="alert" className="shrink-0 text-xs text-fw-danger">Copy failed</span>}
  </span>
}

export default function TasksView({ onBack, onOpenSession }: { onBack?: () => void; onOpenSession?: (sessionId: string) => void }) {
  const tabHeader = useWorkbenchTabHeader()
  const rootRef = useRef<HTMLElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [view, setView] = useState<'table' | 'board'>('table')
  const [scope, setScope] = useState<TaskScope>('work')
  const [refresh, setRefresh] = useState(0)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [omittedByStatus, setOmittedByStatus] = useState<Record<typeof STATUSES[number], number>>({ open: 0, active: 0, completed: 0, cancelled: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<TaskDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createOwner, setCreateOwner] = useState<string | null>(() => readLastTaskOwner())
  const [createNotify, setCreateNotify] = useState(true)
  const [createSaving, setCreateSaving] = useState(false)
  const [createError, setCreateError] = useState('')
  const [taskWarning, setTaskWarning] = useState('')
  const [comment, setComment] = useState('')
  const [commentNotify, setCommentNotify] = useState(true)
  const [commentSaving, setCommentSaving] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [ownerDraft, setOwnerDraft] = useState<string | null>(null)
  const [ownerNotify, setOwnerNotify] = useState(true)
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [ownerError, setOwnerError] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [agentRelation, setAgentRelation] = useState<typeof AGENT_RELATIONS[number]>('ownerOrCreator')
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024)
  const commentRequest = useRef(0)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(entries => setIsNarrow(entries[0].contentRect.width < 1000))
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const ids = [...new Set(tasks.flatMap(task => [task.ownerSessionId, task.createdBySessionId]).filter((id): id is string => !!id))]
    if (!ids.length) return
    const controller = new AbortController()
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100))
    void Promise.all(chunks.map(async ids => {
      const response = await fetch(makeApiUrl('/session-list/by-id'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, includePaths: false }), signal: controller.signal,
      })
      if (!response.ok) return []
      const payload = await response.json() as { results?: { requestedId: string; session?: { displayName?: string } | null }[] }
      return (payload.results || []).flatMap(item => item.session?.displayName?.trim() ? [[item.requestedId, item.session.displayName.trim()] as const] : [])
    })).then(results => { if (!controller.signal.aborted) setSessionNames(Object.fromEntries(results.flat())) }).catch(() => {})
    return () => controller.abort()
  }, [tasks])

  useEffect(() => {
    if (!filtersOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [filtersOpen])

  useEffect(() => {
    if (!selectedId || !isNarrow) return
    const pane = detailRef.current
    pane?.querySelector<HTMLButtonElement>('[aria-label="Close task details"]')?.focus({ preventScroll: true })
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !pane) return
      const items = [...pane.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !pane.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => document.removeEventListener('keydown', trapFocus)
  }, [selectedId, isNarrow])

  const scopedStatuses = TASK_SCOPE_STATUSES[scope]
  const scopedTasks = useMemo(() => tasks.filter(task => scopedStatuses.includes(task.status)), [scopedStatuses, tasks])
  const scopedOmitted = useMemo(() => scopedStatuses.reduce((total, status) => total + (omittedByStatus[status] || 0), 0), [omittedByStatus, scopedStatuses])
  const agentOptions = useMemo(() => [...new Set(scopedTasks.flatMap(task => [task.ownerAgent, task.createdByAgent]
    .filter((agent): agent is string => !!agent)))].sort((a, b) => a.localeCompare(b)), [scopedTasks])
  const visibleTasks = useMemo(() => scopedTasks.filter(task => {
    const agentMatches = !agentFilter || (agentRelation === 'owner' ? task.ownerAgent === agentFilter
      : agentRelation === 'creator' ? task.createdByAgent === agentFilter
      : task.ownerAgent === agentFilter || task.createdByAgent === agentFilter)
    const query = search.trim().toLocaleLowerCase()
    return agentMatches && (!query || [task.title, task.ownerSessionId, task.createdBySessionId, sessionNames[task.ownerSessionId || '']].some(text => text?.toLocaleLowerCase().includes(query)))
  }), [agentFilter, agentRelation, scopedTasks, search, sessionNames])

  const filteredOut = scopedTasks.length - visibleTasks.length

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    // The API's unfiltered list includes only unfinished tasks. Read each
    // status explicitly so both views also include bounded terminal tasks.
    void Promise.all(STATUSES.map(status => {
      const url = makeApiUrl('/tasks')
      url.searchParams.set('status', status)
      url.searchParams.set('limit', String(LIST_LIMIT))
      return readTasks<TaskList>(url, controller.signal)
    })).then(windows => {
      if (controller.signal.aborted) return
      setTasks(windows.flatMap(window => window.tasks).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)))
      setOmittedByStatus(Object.fromEntries(STATUSES.map((status, index) => [status, windows[index].omitted])) as Record<typeof STATUSES[number], number>)
      window.dispatchEvent(new CustomEvent('foxwarm-task-counts', { detail: { open: windows[0].total, active: windows[1].total } }))
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load tasks.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    setDetails(null)
    setDetailsLoading(true)
    setDetailsError('')
    void readTasks<TaskDetails>(makeApiUrl(`/tasks/${encodeURIComponent(selectedId)}`), controller.signal).then(next => {
      if (!controller.signal.aborted) setDetails(next)
    }).catch(cause => {
      if (!controller.signal.aborted) setDetailsError(cause instanceof Error ? cause.message : 'Unable to load task details.')
    }).finally(() => {
      if (!controller.signal.aborted) setDetailsLoading(false)
    })
    return () => controller.abort()
  }, [selectedId, refresh])

  useEffect(() => {
    setOwnerDraft(details?.task.ownerSessionId || null)
    setOwnerError('')
  }, [details?.task.id, details?.task.ownerSessionId])

  useEffect(() => {
    commentRequest.current += 1
    setComment('')
    setCommentError('')
    setCommentSaving(false)
  }, [selectedId])

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    setCreateError('')
    if (!createTitle.trim()) {
      setCreateError('Enter a task title.')
      return
    }
    setCreateSaving(true)
    try {
      const result = await writeTask<TaskWriteResult>('/tasks', {
        title: createTitle.trim(),
        ...(createDescription ? { description: createDescription } : {}),
        ...(createOwner ? { ownerSessionId: createOwner } : {}),
        notifySession: createNotify,
      })
      writeLastTaskOwner(result.task.ownerSessionId || null)
      setTaskWarning(result.warning || '')
      setCreateOpen(false)
      setCreateTitle('')
      setCreateDescription('')
      setCreateOwner(result.task.ownerSessionId || null)
      setSelectedId(result.task.id)
      setRefresh(value => value + 1)
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Unable to create task.')
    } finally {
      setCreateSaving(false)
    }
  }

  const submitComment = async (event: React.FormEvent) => {
    event.preventDefault()
    const taskId = selectedId
    const text = comment.trim()
    if (!taskId || !text) return
    const requestId = ++commentRequest.current
    setCommentSaving(true)
    setCommentError('')
    try {
      const result = await writeTask<TaskWriteResult>(`/tasks/${encodeURIComponent(taskId)}/comments`, { note: text, notifySession: commentNotify })
      if (commentRequest.current !== requestId) return
      setComment('')
      setTaskWarning(result.warning || '')
      setRefresh(value => value + 1)
    } catch (cause) {
      if (commentRequest.current === requestId) setCommentError(cause instanceof Error ? cause.message : 'Unable to save comment.')
    } finally {
      if (commentRequest.current === requestId) setCommentSaving(false)
    }
  }

  const submitOwner = async () => {
    const taskId = selectedId
    if (!taskId) return
    setOwnerSaving(true)
    setOwnerError('')
    try {
      const result = await writeTask<TaskWriteResult>(`/tasks/${encodeURIComponent(taskId)}/assign`, { ownerSessionId: ownerDraft, notifySession: ownerNotify })
      writeLastTaskOwner(result.task.ownerSessionId || null)
      setTaskWarning(result.warning || '')
      setRefresh(value => value + 1)
    } catch (cause) {
      setOwnerError(cause instanceof Error ? cause.message : 'Unable to change owner.')
    } finally {
      setOwnerSaving(false)
    }
  }

  const detailPanel = selectedId && (
    <aside ref={detailRef} data-task-details data-task-narrow={isNarrow || undefined} {...(isNarrow ? { role: 'dialog', 'aria-modal': 'true' } : {})} aria-label="Task details" aria-busy={detailsLoading} className="tasks-detail-panel text-fw-text">
      <div className="mb-4 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Task details</h3><button type="button" className={buttonClass} aria-label="Close task details" onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></button></div>
      {taskWarning && <p role="alert" data-task-warning="detail" className="mb-4 rounded border border-fw-danger/40 bg-fw-danger/10 p-2 text-xs text-fw-danger lg:hidden">{taskWarning}</p>}
      {detailsLoading ? <p role="status" className="text-sm text-fw-text-muted">Loading task details…</p>
        : detailsError ? <p role="alert" className="text-sm text-fw-danger">{detailsError}</p>
        : details && <>
          <TaskStatusBadge status={details.task.status} /><h4 className="tasks-detail-title">{details.task.title}</h4>
          <p className="mb-4 break-all text-xs text-fw-text-muted">{details.task.id}</p>
          <dl className="space-y-3 text-sm">
            {[

              ...(details.task.description ? [['Description', details.task.description]] : []),
              ...(details.task.parentTaskId ? [['Parent', details.task.parentTaskId]] : []),
              ['Owner', details.task.ownerSessionId ? <SessionReference sessionId={details.task.ownerSessionId} agent={details.task.ownerAgent} compact={false} onOpenSession={onOpenSession} /> : 'Unassigned'],
              ['Created by', details.task.createdByKind === 'user' ? 'User' : details.task.createdBySessionId ? <SessionReference sessionId={details.task.createdBySessionId} agent={details.task.createdByAgent} compact={false} onOpenSession={onOpenSession} /> : 'Unknown'],
              ['Updated', formatTime(details.task.updatedAt)],
              ...(details.task.result ? [['Result', details.task.result]] : []),
              ].map(([label, value]) => <div key={String(label)}><dt className="mb-1 text-xs text-fw-text-muted">{label}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</dd></div>)}
          </dl>
          <section className="tasks-detail-section">
            <h4 className="mb-2 text-sm font-semibold">Owner</h4>
            <SessionSelector value={ownerDraft} onChange={setOwnerDraft} allowUnassigned disabled={ownerSaving || details.task.status === 'completed' || details.task.status === 'cancelled'} placeholder="Choose owner Session" />
            <label className="mt-3 flex items-center gap-2 text-xs text-fw-text-muted"><input type="checkbox" checked={ownerNotify} onChange={event => setOwnerNotify(event.target.checked)} disabled={ownerSaving || details.task.status === 'completed' || details.task.status === 'cancelled'} /> Notify owner changes</label>
            {ownerError && <p role="alert" className="mt-2 text-xs text-fw-danger">{ownerError}</p>}
            <button type="button" data-task-owner-save className={`${buttonClass} mt-3`} onClick={() => void submitOwner()} disabled={ownerSaving || details.task.status === 'completed' || details.task.status === 'cancelled' || ownerDraft === details.task.ownerSessionId}>{ownerSaving ? 'Saving…' : 'Save owner'}</button>
          </section>
          <h4 className="mb-2 mt-5 text-sm font-semibold">Children</h4>
          {details.children.length === 0 ? <p className="text-xs text-fw-text-muted">No child tasks</p> : <ul className="space-y-2">{details.children.map(child => <li key={child.id}><button type="button" onClick={() => setSelectedId(child.id)} className="break-words text-left text-sm text-fw-accent hover:underline">{child.title}</button><span className="ml-2 text-xs text-fw-text-muted">{STATUS_LABELS[child.status]}</span></li>)}</ul>}
          {details.childrenOmitted > 0 && <p className="mt-2 text-xs text-fw-text-muted">{details.childrenOmitted} more child tasks</p>}
          <h4 className="mb-2 mt-5 text-sm font-semibold">Notes</h4>
          {details.notes.length === 0 ? <p className="text-xs text-fw-text-muted">No notes</p> : <ul className="space-y-3">{details.notes.map((note, index) => <li key={index} className="tasks-note">
            <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{note.text}</p>
            <p className="mt-2 break-all text-xs text-fw-text-muted">{note.authorKind === 'user' ? 'User' : note.sessionId || 'Unknown'} · {formatTime(note.createdAt)}</p>
          </li>)}</ul>}
          {details.notesOmitted > 0 && <p className="mt-2 text-xs text-fw-text-muted">{details.notesOmitted} more notes</p>}
          <form onSubmit={submitComment} className="tasks-detail-section">
            <h4 className="mb-2 text-sm font-semibold">Comment</h4>
            <textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={1000} rows={4} placeholder="Add a comment" className="w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm text-fw-text outline-none" disabled={commentSaving} />
            <label className="mt-2 flex items-center gap-2 text-xs text-fw-text-muted"><input type="checkbox" checked={commentNotify} onChange={event => setCommentNotify(event.target.checked)} disabled={commentSaving} /> Notify current owner</label>
            {commentError && <p role="alert" className="mt-2 text-xs text-fw-danger">{commentError}</p>}
            <button type="submit" className={`${buttonClass} mt-3`} disabled={commentSaving || !comment.trim()}>{commentSaving ? 'Saving…' : 'Add comment'}</button>
          </form>
        </>}
    </aside>
  )

  return <SessionNames.Provider value={sessionNames}><section ref={rootRef} onKeyDown={event => {
    if (event.key !== 'Escape') return
    if (createOpen) { if (!createSaving) setCreateOpen(false) }
    else if (filtersOpen) { setFiltersOpen(false); filterRef.current?.querySelector('button')?.focus() }
    else if (selectedId) {
      const id = selectedId
      setSelectedId(null)
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-task-row="${CSS.escape(id)}"] .tasks-title-button`)?.focus({ preventScroll: true })
      rootRef.current?.querySelector<HTMLElement>(`[data-task-card="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
    }
  }} data-tasks-view data-task-narrow={isNarrow || undefined} aria-busy={loading} className="tasks-workbench flex h-full min-h-0 min-w-0 flex-col bg-fw-canvas text-fw-text">
    <header className="tasks-header">
      <WorkbenchHeaderDragArea className="tasks-heading-row">
        {tabHeader ? <WorkbenchTabClose className={buttonClass} iconClassName="h-4 w-4" /> : onBack && <button type="button" className={buttonClass} onClick={onBack} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>}
        <div className="tasks-heading"><WorkbenchTabIcon className="tasks-heading-icon"><ClipboardList size={18} /></WorkbenchTabIcon><h2>Tasks</h2></div>
        <div className="tasks-heading-actions">
          <button type="button" className="task-button task-icon-button" title="Refresh" aria-label="Refresh" disabled={loading || (detailsLoading && !!selectedId)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
          <button type="button" data-task-new className="task-button task-primary bg-fw-accent" onClick={() => { setCreateError(''); setTaskWarning(''); setCreateOwner(readLastTaskOwner()); setCreateOpen(true) }}><Plus size={15} />New task</button>
          <WorkbenchPaneControls />
        </div>
      </WorkbenchHeaderDragArea>
      <div className="tasks-toolbar-region foxwarm-content-gutter">
        <div className="tasks-toolbar foxwarm-content-column">
          <div role="group" aria-label="Task scope" className="tasks-scope-tabs" data-task-scopes>
            {TASK_SCOPES.map(nextScope => <button key={nextScope} type="button" data-task-scope={nextScope} aria-pressed={scope === nextScope} onClick={() => setScope(nextScope)}>{TASK_SCOPE_LABELS[nextScope]}</button>)}
          </div>
          <div className="tasks-toolbar-actions" data-task-filters>
            <label className="tasks-search"><Search size={14} aria-hidden="true" /><input aria-label="Search tasks" placeholder="Search tasks" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label className="tasks-agent-select" htmlFor="task-agent-filter"><span className="sr-only">Agent</span><select id="task-agent-filter" data-task-agent-filter value={agentFilter} onChange={event => setAgentFilter(event.target.value)}><option value="">All agents</option>{agentOptions.map(agent => <option key={agent} value={agent}>{agent}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label>
            <div ref={filterRef} className="tasks-filter-control">
              <button type="button" className="task-button task-icon-button" aria-label="Relationship filter" title="Relationship filter" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={15} /></button>
              {filtersOpen && <div className="tasks-filter-popover"><label htmlFor="task-agent-relation">Relationship</label><select id="task-agent-relation" data-task-agent-relation value={agentRelation} onChange={event => setAgentRelation(event.target.value as typeof AGENT_RELATIONS[number])}>{AGENT_RELATIONS.map(relation => <option key={relation} value={relation}>{AGENT_RELATION_LABELS[relation]}</option>)}</select></div>}
            </div>
            <div role="group" aria-label="Task view" className="tasks-view-toggle">
              {(['table', 'board'] as const).map(mode => <button key={mode} type="button" aria-label={mode === 'table' ? 'Table' : 'Board'} title={mode === 'table' ? 'Table' : 'Board'} aria-pressed={view === mode} onClick={() => setView(mode)}>{mode === 'table' ? <List size={16} /> : <Columns3 size={16} />}</button>)}
            </div>
          </div>
        </div>
        {taskWarning && <p role="alert" data-task-warning="header" className="tasks-header-warning">{taskWarning}</p>}
      </div>
    </header>
    <div className="tasks-body">
      <div className="tasks-main foxwarm-content-gutter">
        <div className="tasks-content foxwarm-content-column">
        {loading ? <div role="status" className="tasks-empty"><RefreshCw size={22} className="animate-spin" /><p>Loading tasks…</p></div>
          : error ? <p role="alert" className="tasks-error">{error}</p>
          : <>
            <div className="tasks-list-summary" data-task-summary>
              <strong>{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'}</strong>
              <span className="sr-only">loaded {TASK_SCOPE_LABELS[scope]}</span>
              <span className="tasks-status-counts" data-task-status-counts>{scopedStatuses.map(status => <span key={status}><span className="tasks-count-dot" data-status={status} />{STATUS_LABELS[status]} {scopedTasks.filter(task => task.status === status).length}</span>)}</span>
            </div>
            {(filteredOut > 0 || scopedOmitted > 0) && <p className="tasks-secondary-summary" data-task-secondary-summary>{filteredOut > 0 && <>{filteredOut} hidden by filters.</>}{filteredOut > 0 && scopedOmitted > 0 && ' '}{scopedOmitted > 0 && <>{scopedOmitted} additional tasks not loaded.</>}</p>}
            {view === 'table' ? visibleTasks.length === 0 ? <div className="tasks-empty"><ClipboardList size={28} /><p>{agentFilter || search ? 'No tasks match these filters' : 'No tasks'}</p></div> : <div className="tasks-table-shell">
              <table className="tasks-table">
                <thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col">Owner</th><th scope="col">Updated</th></tr></thead>
                <tbody>{visibleTasks.map(task => <tr key={task.id} data-task-row={task.id} data-selected={selectedId === task.id || undefined}>
                  <td className="tasks-title-cell"><button type="button" onClick={() => setSelectedId(task.id)} className="tasks-title-button" title={task.title}><span>{task.title}</span></button></td>
                  <td className="tasks-status-cell"><TaskStatusBadge status={task.status} /></td>
                  <td className="tasks-owner-cell">{task.ownerSessionId ? <><SessionReference sessionId={task.ownerSessionId} agent={task.ownerAgent} onOpenSession={onOpenSession} /><span className="tasks-owner-agent">{task.ownerAgent}</span></> : <span className="text-fw-text-muted">Unassigned</span>}</td>
                  <td className="tasks-updated-cell"><time title={formatTime(task.updatedAt)} dateTime={new Date(task.updatedAt).toISOString()}>{relativeTime(task.updatedAt)}</time></td>
                </tr>)}</tbody>
              </table>
            </div> : <div data-task-board data-task-board-scope={scope} className="tasks-board" style={{ gridTemplateColumns: `repeat(${scopedStatuses.length}, minmax(240px, 1fr))` }}>
              {scopedStatuses.map(status => {
                const column = visibleTasks.filter(task => task.status === status)
                return <section key={status} data-task-column={status} aria-label={STATUS_LABELS[status]} className="tasks-board-column">
                  <h3><TaskStatusBadge status={status} /><span>{column.length}</span></h3>
                  {column.length === 0 ? <p className="tasks-board-empty">No tasks in this column</p> : <div className="tasks-board-cards">{column.map(task => <div key={task.id} data-task-card={task.id} data-selected={selectedId === task.id || undefined} role="button" tabIndex={0} onClick={() => setSelectedId(task.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(task.id) } }} className="tasks-board-card">
                    <span className="tasks-card-title" title={task.title}>{task.title}</span>
                    <span className="tasks-card-owner">{task.ownerSessionId ? <SessionReference sessionId={task.ownerSessionId} agent={task.ownerAgent} onOpenSession={onOpenSession} /> : 'Unassigned'}</span>
                    <time title={formatTime(task.updatedAt)} dateTime={new Date(task.updatedAt).toISOString()}>{relativeTime(task.updatedAt)}</time>
                  </div>)}</div>}
                </section>
              })}
            </div>}
          </>}
        </div>
      </div>
      {isNarrow ? createPortal(detailPanel, document.body) : detailPanel}
    </div>
    {createOpen && createPortal(<div className="fixed inset-0 z-40 flex items-center justify-center bg-fw-overlay/40 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !createSaving) setCreateOpen(false) }}>
      <form role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={submitCreate} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-5 text-fw-text shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3"><h3 id="new-task-title" className="text-lg font-semibold">New task</h3><button type="button" className={buttonClass} onClick={() => setCreateOpen(false)} disabled={createSaving} aria-label="Close new task">Close</button></div>
        <label className="block text-sm font-medium">Title<input value={createTitle} onChange={event => setCreateTitle(event.target.value)} maxLength={200} autoFocus className="mt-1 w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm" disabled={createSaving} /></label>
        <label className="mt-3 block text-sm font-medium">Description<textarea value={createDescription} onChange={event => setCreateDescription(event.target.value)} maxLength={20000} rows={5} className="mt-1 w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm" disabled={createSaving} /></label>
        <label className="mt-3 block text-sm font-medium">Owner Session<div className="mt-2"><SessionSelector value={createOwner} onChange={setCreateOwner} allowUnassigned disabled={createSaving} placeholder="Choose owner Session" /></div></label>
        <label className="mt-3 flex items-center gap-2 text-xs text-fw-text-muted"><input type="checkbox" checked={createNotify} onChange={event => setCreateNotify(event.target.checked)} disabled={createSaving} /> Notify the owner</label>
        {createError && <p role="alert" className="mt-3 text-sm text-fw-danger">{createError}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" className={buttonClass} onClick={() => setCreateOpen(false)} disabled={createSaving}>Cancel</button><button type="submit" className={`${buttonClass} bg-fw-accent-surface text-fw-accent`} disabled={createSaving}>{createSaving ? 'Creating…' : 'Create task'}</button></div>
      </form>
    </div>, document.body)}
  </section></SessionNames.Provider>
}

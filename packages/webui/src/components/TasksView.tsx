import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ClipboardList, X } from 'lucide-react'
import { makeApiUrl } from '../config'
import { WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import SessionSelector from './SessionSelector'
import { copyTextToClipboard } from './chatShared'

const STATUSES = ['open', 'active', 'completed', 'cancelled'] as const
type TaskStatus = typeof STATUSES[number]
const STATUS_LABELS = { open: 'Open', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' }
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
type TaskList = { tasks: TaskSummary[]; omitted: number }
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
const buttonClass = 'rounded border border-fw-border px-2 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:opacity-40'

const compactSessionLabel = (sessionId: string, agent?: string | null) => {
  const parts = sessionId.split('/').filter(Boolean)
  const leaf = parts[parts.length - 1] || sessionId
  const prefix = agent || parts.slice(0, -1).join('/')
  return prefix && prefix !== leaf ? `${prefix} · ${leaf}` : leaf
}

function SessionReference({ sessionId, agent, compact = true, onOpenSession }: { sessionId: string; agent?: string | null; compact?: boolean; onOpenSession?: (sessionId: string) => void }) {
  const label = compact ? compactSessionLabel(sessionId, agent) : sessionId
  return <span data-session-reference={sessionId} className="inline-flex min-w-0 max-w-full items-center gap-1 align-middle" title={sessionId}>
    {onOpenSession ? <button type="button" data-session-open={sessionId} className="min-w-0 truncate text-left text-fw-accent hover:underline" onClick={event => { event.stopPropagation(); onOpenSession(sessionId) }} aria-label={`Open Session ${sessionId}`}>{label}</button> : <span className="min-w-0 truncate">{label}</span>}
    <button type="button" data-session-copy={sessionId} className="shrink-0 px-0.5 text-[10px] text-fw-text-muted hover:text-fw-text" title={`Copy Session ID ${sessionId}`} aria-label={`Copy Session ID ${sessionId}`} onClick={event => { event.stopPropagation(); void copyTextToClipboard(sessionId) }}>Copy</button>
  </span>
}

export default function TasksView({ onBack, onOpenSession }: { onBack?: () => void; onOpenSession?: (sessionId: string) => void }) {
  const tabHeader = useWorkbenchTabHeader()
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
    const handleResize = () => setIsNarrow(window.innerWidth < 1024)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const scopedStatuses = TASK_SCOPE_STATUSES[scope]
  const scopedTasks = useMemo(() => tasks.filter(task => scopedStatuses.includes(task.status)), [scopedStatuses, tasks])
  const scopedOmitted = useMemo(() => scopedStatuses.reduce((total, status) => total + (omittedByStatus[status] || 0), 0), [omittedByStatus, scopedStatuses])
  const agentOptions = useMemo(() => [...new Set(scopedTasks.flatMap(task => [task.ownerAgent, task.createdByAgent]
    .filter((agent): agent is string => !!agent)))].sort((a, b) => a.localeCompare(b)), [scopedTasks])
  const visibleTasks = useMemo(() => {
    if (!agentFilter) return scopedTasks
    return scopedTasks.filter(task => {
      const owner = task.ownerAgent
      const creator = task.createdByAgent
      if (agentRelation === 'owner') return owner === agentFilter
      if (agentRelation === 'creator') return creator === agentFilter
      return owner === agentFilter || creator === agentFilter
    })
  }, [agentFilter, agentRelation, scopedTasks])
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

  return <section data-tasks-view aria-busy={loading} className="flex h-full min-h-0 min-w-0 flex-col bg-fw-canvas text-fw-text">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-fw-border bg-fw-surface p-3">
      {tabHeader ? <WorkbenchTabClose className={buttonClass} iconClassName="h-4 w-4" /> : onBack && <button type="button" className={buttonClass} onClick={onBack} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>}
      <h2 className="mr-2 flex items-center gap-2 text-sm font-semibold"><WorkbenchTabIcon className="inline-flex items-center"><ClipboardList className="h-4 w-4" /></WorkbenchTabIcon>Tasks</h2>
      <button type="button" className={buttonClass} onClick={() => { setCreateError(''); setTaskWarning(''); setCreateOwner(readLastTaskOwner()); setCreateOpen(true) }}>New task</button>
      <div role="group" aria-label="Task scope" className="flex gap-1" data-task-scopes>
        {TASK_SCOPES.map(nextScope => <button key={nextScope} type="button" data-task-scope={nextScope} aria-pressed={scope === nextScope} onClick={() => setScope(nextScope)} className={`${buttonClass} ${scope === nextScope ? 'bg-fw-accent-surface text-fw-accent' : ''}`}>{TASK_SCOPE_LABELS[nextScope]}</button>)}
      </div>
      <div role="group" aria-label="Task view" className="flex gap-1">
        {(['table', 'board'] as const).map(mode => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)} className={`${buttonClass} ${view === mode ? 'bg-fw-accent-surface text-fw-accent' : ''}`}>{mode === 'table' ? 'Table' : 'Board'}</button>)}
      </div>
      <button type="button" className={buttonClass} disabled={loading || (detailsLoading && !!selectedId)} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
      {taskWarning && <p role="alert" data-task-warning="header" className={`${selectedId ? 'hidden lg:block' : ''} basis-full text-xs text-fw-danger sm:basis-auto`}>{taskWarning}</p>}
      <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 border-t border-fw-border pt-3 sm:basis-auto sm:border-t-0 sm:pt-0" data-task-filters>
        <label className="flex items-center gap-2 text-xs text-fw-text-muted" htmlFor="task-agent-filter">
          <span className="whitespace-nowrap">Agent</span>
          <select id="task-agent-filter" data-task-agent-filter value={agentFilter} onChange={event => setAgentFilter(event.target.value)} className="min-w-40 max-w-full rounded border border-fw-border bg-fw-canvas px-2 py-1.5 text-xs text-fw-text">
            <option value="">All agents</option>
            {agentOptions.map(agent => <option key={agent} value={agent}>{agent}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-fw-text-muted" htmlFor="task-agent-relation">
          <span className="whitespace-nowrap">Relationship</span>
          <select id="task-agent-relation" data-task-agent-relation value={agentRelation} onChange={event => setAgentRelation(event.target.value as typeof AGENT_RELATIONS[number])} className="max-w-full rounded border border-fw-border bg-fw-canvas px-2 py-1.5 text-xs text-fw-text">
            {AGENT_RELATIONS.map(relation => <option key={relation} value={relation}>{AGENT_RELATION_LABELS[relation]}</option>)}
          </select>
        </label>
      </div>
    </header>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      <div className="min-w-0 shrink-0 overflow-x-auto p-3 lg:min-h-0 lg:flex-1 lg:overflow-auto">
        {loading ? <p role="status" className="text-sm text-fw-text-muted">Loading tasks…</p>
          : error ? <p role="alert" className="text-sm text-fw-danger">{error}</p>
          : <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fw-text-muted" data-task-summary>
              <strong className="font-medium text-fw-text">{visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'} loaded</strong>
              <span>{TASK_SCOPE_LABELS[scope]}</span>
              <span className="flex flex-wrap gap-x-2" data-task-status-counts>{scopedStatuses.map(status => <span key={status}>{STATUS_LABELS[status]} {scopedTasks.filter(task => task.status === status).length}</span>)}</span>
            </div>
            {(filteredOut > 0 || scopedOmitted > 0) && <p className="mb-3 text-xs text-fw-text-muted" data-task-secondary-summary>{filteredOut > 0 && <>Agent filter hides {filteredOut} loaded {filteredOut === 1 ? 'task' : 'tasks'}.</>}{filteredOut > 0 && scopedOmitted > 0 && ' '}{scopedOmitted > 0 && <>Additional tasks not loaded: {scopedOmitted}.</>}</p>}
            {view === 'table' ? visibleTasks.length === 0 ? <p className="text-sm text-fw-text-muted">{agentFilter ? 'No tasks match this Agent filter' : 'No tasks'}</p> : <div className="overflow-x-auto">
              <table className="min-w-[64rem] w-full text-left text-sm">
                <thead className="text-xs text-fw-text-muted"><tr>
                  <th scope="col" className="min-w-[18rem] whitespace-nowrap border-b border-fw-border px-3 py-2 font-medium">Title</th>
                  <th scope="col" className="min-w-[8rem] whitespace-nowrap border-b border-fw-border px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="min-w-[16rem] whitespace-nowrap border-b border-fw-border px-3 py-2 font-medium">Owner</th>
                  <th scope="col" className="min-w-[16rem] whitespace-nowrap border-b border-fw-border px-3 py-2 font-medium">Created by</th>
                  <th scope="col" className="min-w-[13rem] whitespace-nowrap border-b border-fw-border px-3 py-2 font-medium">Updated</th>
                </tr></thead>
                <tbody>{visibleTasks.map(task => <tr key={task.id} data-task-row={task.id} className="border-b border-fw-border">
                  <td className="min-w-[18rem] px-3 py-2"><button type="button" onClick={() => setSelectedId(task.id)} className="break-words text-left text-fw-accent hover:underline">{task.title}</button></td>
                  <td className="min-w-[8rem] whitespace-nowrap px-3 py-2">{STATUS_LABELS[task.status]}</td>
                  <td className="min-w-[16rem] whitespace-nowrap px-3 py-2">{task.ownerSessionId ? <SessionReference sessionId={task.ownerSessionId} agent={task.ownerAgent} onOpenSession={onOpenSession} /> : 'Unassigned'}</td>
                  <td className="min-w-[16rem] whitespace-nowrap px-3 py-2">{task.createdByKind === 'user' ? 'User' : task.createdBySessionId ? <SessionReference sessionId={task.createdBySessionId} agent={task.createdByAgent} onOpenSession={onOpenSession} /> : 'Unknown'}</td>
                  <td className="min-w-[13rem] whitespace-nowrap px-3 py-2"><time dateTime={new Date(task.updatedAt).toISOString()}>{formatTime(task.updatedAt)}</time></td>
                </tr>)}</tbody>
              </table>
            </div> : <div data-task-board data-task-board-scope={scope} className={`grid items-start gap-3 ${scope === 'all' ? 'min-w-[760px] grid-cols-4' : 'min-w-[480px] grid-cols-2'}`}>
              {scopedStatuses.map(status => {
                const column = visibleTasks.filter(task => task.status === status)
                return <section key={status} data-task-column={status} aria-label={STATUS_LABELS[status]} className="min-w-0 rounded border border-fw-border bg-fw-surface p-3">
                  <h3 className="mb-3 text-sm font-semibold">{STATUS_LABELS[status]} <span className="text-fw-text-muted">{column.length}</span></h3>
                  {column.length === 0 ? <p className="text-xs text-fw-text-muted">No tasks in this column</p> : <div className="space-y-2">{column.map(task => <div key={task.id} data-task-card={task.id} role="button" tabIndex={0} onClick={() => setSelectedId(task.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(task.id) } }} className="block w-full rounded border border-fw-border bg-fw-canvas p-3 text-left hover:bg-fw-hover">
                    <span className="mb-2 block break-words text-sm font-medium">{task.title}</span>
                    <span className="block break-all text-xs text-fw-text-muted">{task.id}</span>
                    <span className="mt-2 block min-w-0 truncate text-xs">{task.ownerSessionId ? <SessionReference sessionId={task.ownerSessionId} agent={task.ownerAgent} onOpenSession={onOpenSession} /> : 'Unassigned'}</span>
                    <time className="mt-1 block text-xs text-fw-text-muted" dateTime={new Date(task.updatedAt).toISOString()}>{formatTime(task.updatedAt)}</time>
                  </div>)}</div>}
                </section>
              })}
            </div>}
          </>}
      </div>
      {selectedId && <aside data-task-details {...(isNarrow ? { role: 'dialog', 'aria-modal': 'true' } : {})} aria-label="Task details" aria-busy={detailsLoading} className="fixed inset-0 z-20 min-w-0 overflow-auto border-t border-fw-border bg-fw-surface p-4 lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-96 lg:shrink-0 lg:border-l lg:border-t-0">
        <div className="mb-4 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Task details</h3><button type="button" className={buttonClass} aria-label="Close task details" onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></button></div>
        {taskWarning && <p role="alert" data-task-warning="detail" className="mb-4 rounded border border-fw-danger/40 bg-fw-danger/10 p-2 text-xs text-fw-danger lg:hidden">{taskWarning}</p>}
        {detailsLoading ? <p role="status" className="text-sm text-fw-text-muted">Loading task details…</p>
          : detailsError ? <p role="alert" className="text-sm text-fw-danger">{detailsError}</p>
          : details && <>
            <h4 className="mb-1 break-words font-semibold">{details.task.title}</h4>
            <p className="mb-4 break-all text-xs text-fw-text-muted">{details.task.id}</p>
            <dl className="space-y-3 text-sm">
              {[
                ['Status', STATUS_LABELS[details.task.status]],
                ['Description', details.task.description || 'No description'],
                ['Parent', details.task.parentTaskId || 'None'],
                ['Owner', details.task.ownerSessionId ? <SessionReference sessionId={details.task.ownerSessionId} agent={details.task.ownerAgent} compact={false} onOpenSession={onOpenSession} /> : 'Unassigned'],
                ['Created by', details.task.createdByKind === 'user' ? 'User' : details.task.createdBySessionId ? <SessionReference sessionId={details.task.createdBySessionId} agent={details.task.createdByAgent} compact={false} onOpenSession={onOpenSession} /> : 'Unknown'],
                ['Updated', formatTime(details.task.updatedAt)],
                ['Result', details.task.result || 'No result'],
                ].map(([label, value]) => <div key={String(label)}><dt className="mb-1 text-xs text-fw-text-muted">{label}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</dd></div>)}
            </dl>
            <section className="mt-5 rounded border border-fw-border p-3">
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
            {details.notes.length === 0 ? <p className="text-xs text-fw-text-muted">No notes</p> : <ul className="space-y-3">{details.notes.map((note, index) => <li key={index} className="rounded border border-fw-border p-2">
              <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{note.text}</p>
              <p className="mt-2 break-all text-xs text-fw-text-muted">{note.authorKind === 'user' ? 'User' : note.sessionId || 'Unknown'} · {formatTime(note.createdAt)}</p>
            </li>)}</ul>}
            {details.notesOmitted > 0 && <p className="mt-2 text-xs text-fw-text-muted">{details.notesOmitted} more notes</p>}
            <form onSubmit={submitComment} className="mt-5 rounded border border-fw-border p-3">
              <h4 className="mb-2 text-sm font-semibold">Comment</h4>
              <textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={1000} rows={4} placeholder="Add a comment" className="w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm text-fw-text outline-none" disabled={commentSaving} />
              <label className="mt-2 flex items-center gap-2 text-xs text-fw-text-muted"><input type="checkbox" checked={commentNotify} onChange={event => setCommentNotify(event.target.checked)} disabled={commentSaving} /> Notify current owner</label>
              {commentError && <p role="alert" className="mt-2 text-xs text-fw-danger">{commentError}</p>}
              <button type="submit" className={`${buttonClass} mt-3`} disabled={commentSaving || !comment.trim()}>{commentSaving ? 'Saving…' : 'Add comment'}</button>
            </form>
          </>}
      </aside>}
    </div>
    {createOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-fw-overlay/40 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !createSaving) setCreateOpen(false) }}>
      <form role="dialog" aria-modal="true" aria-labelledby="new-task-title" onSubmit={submitCreate} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-fw-border bg-fw-surface p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3"><h3 id="new-task-title" className="text-lg font-semibold">New task</h3><button type="button" className={buttonClass} onClick={() => setCreateOpen(false)} disabled={createSaving} aria-label="Close new task">Close</button></div>
        <label className="block text-sm font-medium">Title<input value={createTitle} onChange={event => setCreateTitle(event.target.value)} maxLength={200} autoFocus className="mt-1 w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm" disabled={createSaving} /></label>
        <label className="mt-3 block text-sm font-medium">Description<textarea value={createDescription} onChange={event => setCreateDescription(event.target.value)} maxLength={20000} rows={5} className="mt-1 w-full rounded border border-fw-border bg-fw-canvas p-2 text-sm" disabled={createSaving} /></label>
        <label className="mt-3 block text-sm font-medium">Owner Session<span className="mt-1 block text-xs font-normal text-fw-text-muted">Optional. The last successful owner selection is used by default.</span><div className="mt-2"><SessionSelector value={createOwner} onChange={setCreateOwner} allowUnassigned disabled={createSaving} placeholder="Choose owner Session" /></div></label>
        <label className="mt-3 flex items-center gap-2 text-xs text-fw-text-muted"><input type="checkbox" checked={createNotify} onChange={event => setCreateNotify(event.target.checked)} disabled={createSaving} /> Notify the owner</label>
        {createError && <p role="alert" className="mt-3 text-sm text-fw-danger">{createError}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" className={buttonClass} onClick={() => setCreateOpen(false)} disabled={createSaving}>Cancel</button><button type="submit" className={`${buttonClass} bg-fw-accent-surface text-fw-accent`} disabled={createSaving}>{createSaving ? 'Creating…' : 'Create task'}</button></div>
      </form>
    </div>}
  </section>
}

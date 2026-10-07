import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ClipboardList, X } from 'lucide-react'
import { makeApiUrl } from '../config'
import { WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'

const STATUSES = ['open', 'active', 'completed', 'cancelled'] as const
const STATUS_LABELS = { open: 'Open', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' }
const LIST_LIMIT = 50
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
  createdBySessionId: string
  updatedAt: number
}
type TaskList = { tasks: TaskSummary[]; omitted: number }
type TaskDetails = {
  task: TaskSummary & { description: string | null; result: string | null }
  children: { id: string; title: string; status: typeof STATUSES[number]; ownerSessionId: string | null }[]
  childrenOmitted: number
  notes: { sessionId: string; text: string; createdAt: number }[]
  notesOmitted: number
}

async function readTasks<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to load tasks.')
  return data as T
}

const formatTime = (value: number) => new Date(value).toLocaleString()
const buttonClass = 'rounded border border-fw-border px-2 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:opacity-40'

export default function TasksView({ onBack }: { onBack?: () => void }) {
  const tabHeader = useWorkbenchTabHeader()
  const [view, setView] = useState<'table' | 'board'>('table')
  const [refresh, setRefresh] = useState(0)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [omitted, setOmitted] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<TaskDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [agentRelation, setAgentRelation] = useState<typeof AGENT_RELATIONS[number]>('ownerOrCreator')

  const agentOptions = useMemo(() => [...new Set(tasks.flatMap(task => [task.ownerSessionId, task.createdBySessionId]
    .filter((sessionId): sessionId is string => !!sessionId)
    .map(sessionId => sessionId.includes('/') ? sessionId.slice(0, sessionId.indexOf('/')) : sessionId)))].sort((a, b) => a.localeCompare(b)), [tasks])
  const visibleTasks = useMemo(() => {
    if (!agentFilter) return tasks
    return tasks.filter(task => {
      const owner = task.ownerSessionId?.split('/')[0]
      const creator = task.createdBySessionId.split('/')[0]
      if (agentRelation === 'owner') return owner === agentFilter
      if (agentRelation === 'creator') return creator === agentFilter
      return owner === agentFilter || creator === agentFilter
    })
  }, [agentFilter, agentRelation, tasks])
  const filteredOut = tasks.length - visibleTasks.length

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
      setOmitted(windows.reduce((count, window) => count + window.omitted, 0))
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

  return <section data-tasks-view aria-busy={loading} className="flex h-full min-h-0 min-w-0 flex-col bg-fw-canvas text-fw-text">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-fw-border bg-fw-surface p-3">
      {tabHeader ? <WorkbenchTabClose className={buttonClass} iconClassName="h-4 w-4" /> : onBack && <button type="button" className={buttonClass} onClick={onBack} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>}
      <h2 className="mr-2 flex items-center gap-2 text-sm font-semibold"><WorkbenchTabIcon className="inline-flex items-center"><ClipboardList className="h-4 w-4" /></WorkbenchTabIcon>Tasks</h2>
      <div role="group" aria-label="Task view" className="flex gap-1">
        {(['table', 'board'] as const).map(mode => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)} className={`${buttonClass} ${view === mode ? 'bg-fw-accent-surface text-fw-accent' : ''}`}>{mode === 'table' ? 'Table' : 'Board'}</button>)}
      </div>
      <button type="button" className={buttonClass} disabled={loading || (detailsLoading && !!selectedId)} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
      <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 border-t border-fw-border pt-3 sm:basis-auto sm:border-t-0 sm:pt-0" data-task-filters>
        <label className="flex items-center gap-2 text-xs text-fw-text-muted" htmlFor="task-agent-filter">
          <span className="whitespace-nowrap">Agent filter ({AGENT_RELATION_LABELS[agentRelation]})</span>
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
            {(omitted > 0 || filteredOut > 0) && <p className="mb-3 text-xs text-fw-text-muted">{visibleTasks.length} tasks shown{filteredOut > 0 && <> · {filteredOut} hidden by the Agent filter</>}{omitted > 0 && <> · {omitted} more tasks not loaded</>}</p>}
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
                  <td className="min-w-[16rem] whitespace-nowrap px-3 py-2">{task.ownerSessionId || 'Unassigned'}</td>
                  <td className="min-w-[16rem] whitespace-nowrap px-3 py-2">{task.createdBySessionId}</td>
                  <td className="min-w-[13rem] whitespace-nowrap px-3 py-2"><time dateTime={new Date(task.updatedAt).toISOString()}>{formatTime(task.updatedAt)}</time></td>
                </tr>)}</tbody>
              </table>
            </div> : <div data-task-board className="grid min-w-[760px] grid-cols-4 items-start gap-3">
              {STATUSES.map(status => {
                const column = visibleTasks.filter(task => task.status === status)
                return <section key={status} data-task-column={status} aria-label={STATUS_LABELS[status]} className="min-w-0 rounded border border-fw-border bg-fw-surface p-3">
                  <h3 className="mb-3 text-sm font-semibold">{STATUS_LABELS[status]} <span className="text-fw-text-muted">{column.length}</span></h3>
                  {column.length === 0 ? <p className="text-xs text-fw-text-muted">No tasks in this column</p> : <div className="space-y-2">{column.map(task => <button key={task.id} type="button" data-task-card={task.id} onClick={() => setSelectedId(task.id)} className="block w-full rounded border border-fw-border bg-fw-canvas p-3 text-left hover:bg-fw-hover">
                    <span className="mb-2 block break-words text-sm font-medium">{task.title}</span>
                    <span className="block break-all text-xs text-fw-text-muted">{task.id}</span>
                    <span className="mt-2 block break-all text-xs">{task.ownerSessionId || 'Unassigned'}</span>
                    <time className="mt-1 block text-xs text-fw-text-muted" dateTime={new Date(task.updatedAt).toISOString()}>{formatTime(task.updatedAt)}</time>
                  </button>)}</div>}
                </section>
              })}
            </div>}
          </>}
      </div>
      {selectedId && <aside data-task-details role="dialog" aria-modal="true" aria-label="Task details" aria-busy={detailsLoading} className="fixed inset-0 z-20 min-w-0 overflow-auto border-t border-fw-border bg-fw-surface p-4 lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-96 lg:shrink-0 lg:border-l lg:border-t-0">
        <div className="mb-4 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Task details</h3><button type="button" className={buttonClass} aria-label="Close task details" onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></button></div>
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
                ['Owner', details.task.ownerSessionId || 'Unassigned'],
                ['Created by', details.task.createdBySessionId],
                ['Updated', formatTime(details.task.updatedAt)],
                ['Result', details.task.result || 'No result'],
              ].map(([label, value]) => <div key={label}><dt className="mb-1 text-xs text-fw-text-muted">{label}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</dd></div>)}
            </dl>
            <h4 className="mb-2 mt-5 text-sm font-semibold">Children</h4>
            {details.children.length === 0 ? <p className="text-xs text-fw-text-muted">No child tasks</p> : <ul className="space-y-2">{details.children.map(child => <li key={child.id}><button type="button" onClick={() => setSelectedId(child.id)} className="break-words text-left text-sm text-fw-accent hover:underline">{child.title}</button><span className="ml-2 text-xs text-fw-text-muted">{STATUS_LABELS[child.status]}</span></li>)}</ul>}
            {details.childrenOmitted > 0 && <p className="mt-2 text-xs text-fw-text-muted">{details.childrenOmitted} more child tasks</p>}
            <h4 className="mb-2 mt-5 text-sm font-semibold">Notes</h4>
            {details.notes.length === 0 ? <p className="text-xs text-fw-text-muted">No notes</p> : <ul className="space-y-3">{details.notes.map((note, index) => <li key={index} className="rounded border border-fw-border p-2">
              <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{note.text}</p>
              <p className="mt-2 break-all text-xs text-fw-text-muted">{note.sessionId} · {formatTime(note.createdAt)}</p>
            </li>)}</ul>}
            {details.notesOmitted > 0 && <p className="mt-2 text-xs text-fw-text-muted">{details.notesOmitted} more notes</p>}
          </>}
      </aside>}
    </div>
  </section>
}

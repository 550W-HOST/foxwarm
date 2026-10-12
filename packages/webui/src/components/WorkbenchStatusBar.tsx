import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CirclePlay, ClipboardList, Clock3, Server } from 'lucide-react'
import { makeApiUrl } from '../config'
import type { WebUiNodeTarget } from '../nodeTargets'
import type { Session } from './SessionListCore'
import { getSessionRuntimeStateName, isSessionRuntimeActive } from '../sessionRuntimeState'

export const TASK_COUNTS_EVENT = 'foxwarm-task-counts'
type TaskCounts = { open: number; active: number }
type StatusSection = 'running' | 'waiting' | 'tasks' | 'nodes'
type TaskPreview = { id: string; title: string; status: string }
function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export default function WorkbenchStatusBar({ running, sessions, nodes }: {
  running: number; sessions: readonly Session[]; nodes: readonly WebUiNodeTarget[]
}) {
  const [tasks, setTasks] = useState<TaskCounts | null>(null)
  const [open, setOpen] = useState<StatusSection | null>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const [taskPreview, setTaskPreview] = useState<TaskPreview[]>([])
  const [taskPreviewState, setTaskPreviewState] = useState<'loading' | 'ready' | 'error'>('loading')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let controller: AbortController | null = null
    let disposed = false
    const refresh = async () => {
      if (document.hidden || disposed) return
      controller?.abort()
      const request = new AbortController()
      controller = request
      try {
        const counts = await Promise.all(['open', 'active'].map(async status => {
          const url = makeApiUrl('/tasks')
          url.searchParams.set('status', status); url.searchParams.set('limit', '1')
          const response = await fetch(url, { signal: request.signal })
          if (!response.ok) throw new Error('Task counts unavailable')
          const data = await response.json()
          if (!validCount(data.total)) throw new Error('Invalid task count')
          return data.total
        }))
        if (!request.signal.aborted && !disposed) setTasks({ open: counts[0], active: counts[1] })
      } catch {
        if (!request.signal.aborted && !disposed) setTasks(null)
      }
    }
    const synchronize = (event: Event) => {
      const counts = (event as CustomEvent<TaskCounts>).detail
      if (!counts || !validCount(counts.open) || !validCount(counts.active)) return
      controller?.abort(); setTasks(counts)
    }
    const visible = () => { if (!document.hidden) void refresh() }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 60_000)
    window.addEventListener(TASK_COUNTS_EVENT, synchronize)
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer)
      window.removeEventListener(TASK_COUNTS_EVENT, synchronize)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  useEffect(() => {
    if (open !== 'tasks') return
    const controller = new AbortController()
    setTaskPreviewState('loading')
    void Promise.all(['active', 'open'].map(async status => {
      const url = makeApiUrl('/tasks')
      url.searchParams.set('status', status); url.searchParams.set('limit', '3')
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error('Task details unavailable')
      const data = await response.json()
      return Array.isArray(data.tasks) ? data.tasks.filter((task: TaskPreview) => typeof task?.id === 'string' && typeof task.title === 'string' && typeof task.status === 'string').slice(0, 3) as TaskPreview[] : []
    })).then(windows => {
      if (!controller.signal.aborted) { setTaskPreview(windows.flat()); setTaskPreviewState('ready') }
    }).catch(() => { if (!controller.signal.aborted) setTaskPreviewState('error') })
    return () => controller.abort()
  }, [open])

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const update = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!trigger) return
      const width = Math.min(320, innerWidth - 16)
      setPosition({ left: Math.max(8, Math.min(trigger.left, innerWidth - width - 8)), bottom: Math.max(8, innerHeight - trigger.top + 6) })
    }
    update()
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])

  const popupPositioned = position !== null
  useLayoutEffect(() => {
    if (open && popupPositioned) popupRef.current?.focus({ preventScroll: true })
  }, [open, popupPositioned])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!popupRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(null); triggerRef.current?.focus({ preventScroll: true }) }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  const waiting = sessions.filter(session => getSessionRuntimeStateName(session) === 'waiting')
  const active = sessions.filter(isSessionRuntimeActive)
  const readyNodes = nodes.filter(node => node.online && !node.unavailable && node.protocolStatus !== 'upgrade-required')
  const label = open === 'running' ? 'Sessions' : open === 'waiting' ? 'Waiting sessions' : open === 'tasks' ? 'Tasks' : 'Nodes'
  const openSection = (section: StatusSection, element: HTMLButtonElement) => {
    triggerRef.current = element; setOpen(current => current === section ? null : section)
  }
  const itemProps = (section: StatusSection, title: string) => ({
    type: 'button' as const, className: 'foxwarm-status-item', title, 'aria-label': title,
    'aria-expanded': open === section, 'aria-haspopup': 'dialog' as const,
    'data-active': open === section || undefined,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => openSection(section, event.currentTarget),
  })
  const row = (name: string, count: number) => <div className="flex items-center justify-between gap-4 py-1"><span className="text-fw-text-muted">{name}</span><span className="tabular-nums text-fw-text">{count}</span></div>
  return <>
    <footer data-workbench-status-bar className="foxwarm-status-bar" aria-label="Workbench status">
      <div className="flex h-full items-center gap-0.5">
        <button {...itemProps('running', `Running sessions: ${running}`)}><CirclePlay aria-hidden="true" /><span>Running</span><span>{running}</span></button>
        <button {...itemProps('waiting', `Waiting in loaded sessions: ${waiting.length}`)}><Clock3 aria-hidden="true" /><span>Waiting</span><span>{waiting.length}</span></button>
        {tasks && <button {...itemProps('tasks', `Tasks: ${tasks.active} active, ${tasks.open + tasks.active} unfinished`)}><ClipboardList aria-hidden="true" /><span>Tasks</span><span>{tasks.active}/{tasks.open + tasks.active}</span></button>}
      </div>
      <button {...itemProps('nodes', `Ready nodes: ${readyNodes.length}`)}><Server aria-hidden="true" /><span>Nodes</span><span>{readyNodes.length}</span></button>
    </footer>
    {open && createPortal(<div ref={popupRef} role="dialog" aria-label={label} tabIndex={-1} data-workbench-status-popup className="foxwarm-status-popup" style={{ left: position?.left ?? 8, bottom: position?.bottom ?? 32, visibility: position ? 'visible' : 'hidden' }}>
      <h3 className="mb-2 text-sm font-medium text-fw-text-strong">{label}</h3>
      {open === 'running' && <>{row('Running', running)}{row('Loaded sessions', sessions.length)}</>}
      {open === 'waiting' && row('Waiting · loaded sessions', waiting.length)}
      {(open === 'running' || open === 'waiting') && <div className="mt-2 border-t border-fw-border-muted pt-2">{(open === 'running' ? active : waiting).slice(0, 4).map(session => <div key={session.id} className="flex min-w-0 items-center justify-between gap-3 py-1"><span className="truncate" title={session.id}>{session.displayName || session.id}</span><span className="shrink-0 text-[11px] text-fw-text-muted">{getSessionRuntimeStateName(session)}</span></div>)}{!(open === 'running' ? active : waiting).length && <div className="py-1 text-fw-text-muted">No matching loaded sessions</div>}</div>}
      {open === 'tasks' && <>{tasks && <>{row('Active', tasks.active)}{row('Open', tasks.open)}</>}<div className="mt-2 border-t border-fw-border-muted pt-2">{taskPreviewState === 'loading' ? <span className="text-fw-text-muted">Loading…</span> : taskPreviewState === 'error' ? <span className="text-fw-text-muted">Unable to load tasks</span> : taskPreview.map(task => <div key={task.id} className="flex min-w-0 items-center justify-between gap-3 py-1"><span className="truncate" title={task.title}>{task.title}</span><span className="shrink-0 text-[11px] text-fw-text-muted">{task.status}</span></div>)}</div></>}
      {open === 'nodes' && <>{row('Ready', readyNodes.length)}{row('Offline', nodes.filter(node => !node.online).length)}<div className="mt-2 border-t border-fw-border-muted pt-2">{nodes.slice(0, 6).map(node => <div key={node.id} className="flex min-w-0 items-center justify-between gap-3 py-1"><span className="truncate" title={node.id}>{node.displayName}</span><span className="shrink-0 text-[11px] text-fw-text-muted">{!node.online ? 'Offline' : node.protocolStatus === 'upgrade-required' ? 'Upgrade required' : 'Ready'}</span></div>)}</div></>}
    </div>, document.body)}
  </>
}

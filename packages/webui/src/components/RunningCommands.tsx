import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { formatCompactDuration } from '../usageTiming'
import { ExecCommandText } from './ToolExecText'
import { MENU_VIEWPORT_GUTTER, clampAnchoredMenuHorizontally, readHorizontalViewportBounds } from './menuPositioning'

export interface RunningCommand {
  execId: string
  nodeId: string
  command?: string | null
  /** The exec call's stated purpose, when it gave one. */
  summary?: string | null
  startedAt: number
  elapsedMs: number
  cwd?: string | null
  logPath?: string | null
  stopRequested?: boolean
}

type StopOutcome = 'stopped' | 'killed' | 'ended' | 'finished' | 'already-requested' | 'unsupported' | 'unavailable' | 'unknown'

const stopProblems: Partial<Record<StopOutcome | 'error', string>> = {
  unsupported: "This Node can't stop commands.",
  unavailable: "This Node isn't connected right now.",
  unknown: "Couldn't confirm that the command stopped.",
  error: "Couldn't stop this command.",
}

export async function fetchRunningCommands(sessionId: string, signal?: AbortSignal): Promise<RunningCommand[]> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/execs`, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as { execs?: RunningCommand[] }
  return Array.isArray(body.execs) ? body.execs : []
}

export async function stopRunningCommand(sessionId: string, execId: string): Promise<StopOutcome | 'error'> {
  try {
    const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/execs/${encodeURIComponent(execId)}/stop`, { method: 'POST' })
    // A command that is no longer listed has finished in the meantime.
    if (response.status === 404) return 'finished'
    if (!response.ok) return 'error'
    const body = await response.json() as { outcome?: StopOutcome }
    return body.outcome || 'unknown'
  } catch {
    return 'error'
  }
}

/** Polls the list while it is shown so elapsed times move and finished commands drop out. */
export function useRunningCommands(sessionId: string, active: boolean, revision: number) {
  const [commands, setCommands] = useState<RunningCommand[] | null>(null)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchRunningCommands(sessionId, signal)
      setCommands(list)
      setFailed(false)
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') setFailed(true)
    }
  }, [sessionId])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => void load(controller.signal), 2000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [active, load, revision])
  return { commands, failed, reload: load }
}

/** A row's collapsed text: the exec call's purpose, else the command's first non-blank line. */
export function runningCommandLabel(command: Pick<RunningCommand, 'execId' | 'command' | 'summary'>): { text: string; purpose: boolean } {
  const summary = command.summary?.replace(/\s+/g, ' ').trim()
  if (summary) return { text: summary, purpose: true }
  const firstLine = (command.command || '').split('\n').find(line => line.trim())?.trim()
  return { text: firstLine || command.execId, purpose: false }
}

const RunningCommandRow = memo(function RunningCommandRow({ sessionId, command, onChanged }: { sessionId: string; command: RunningCommand; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(!!command.stopRequested)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { if (command.stopRequested) setStopping(true) }, [command.stopRequested])
  const label = runningCommandLabel(command)
  const stop = async () => {
    setStopping(true)
    setProblem(null)
    const outcome = await stopRunningCommand(sessionId, command.execId)
    const message = stopProblems[outcome]
    if (message) {
      setStopping(false)
      setProblem(message)
    }
    onChanged()
  }
  return <li data-running-command={command.execId} className="flex min-w-0 flex-col gap-1 border-b border-fw-border py-2 last:border-b-0">
    <div className="flex min-w-0 items-center gap-2">
      <button type="button" data-running-command-toggle onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={expanded ? undefined : label.text}
        className="foxwarm-running-command-toggle flex min-h-7 min-w-0 flex-1 items-center gap-1 text-left text-xs text-fw-text-strong hover:opacity-80 focus-visible:underline">
        <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 text-fw-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span data-running-command-label={label.purpose ? 'summary' : 'command'} className={`min-w-0 flex-1 truncate ${label.purpose ? '' : 'font-mono'}`}>{label.text}</span>
      </button>
      <button type="button" data-running-command-stop disabled={stopping} onClick={() => void stop()}
        className="foxwarm-running-command-stop inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-fw-text-muted transition-colors hover:bg-fw-hover hover:text-fw-danger focus-visible:underline disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fw-text-muted">
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
    {expanded && <pre data-running-command-text className="m-0 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-md bg-fw-surface-sunken px-2 py-1.5 font-mono text-xs text-fw-text cursor-text dark:bg-fw-canvas/50">
      {command.command ? <ExecCommandText command={command.command} heredocBodyBlock={false} /> : command.execId}
    </pre>}
    <div className="flex min-w-0 flex-wrap gap-x-2 pl-[1.125rem] text-xs text-fw-text-muted">
      {command.nodeId !== 'master' && <span className="min-w-0 truncate">{command.nodeId}</span>}
      <span>{formatCompactDuration(Math.max(0, command.elapsedMs))}</span>
    </div>
    {problem && <p role="alert" className="pl-[1.125rem] text-xs text-fw-danger">{problem}</p>}
  </li>
})

/** The commands a Session still runs in the background, each with a Stop action. */
export const RunningCommandList = memo(function RunningCommandList({ sessionId, active, revision = 0, emptyText }: { sessionId: string; active: boolean; revision?: number; emptyText?: string }) {
  const { commands, failed, reload } = useRunningCommands(sessionId, active, revision)
  if (commands === null) return failed ? <p className="text-xs text-fw-text-muted">Couldn't load running commands.</p> : null
  if (commands.length === 0) return emptyText ? <p className="text-xs text-fw-text-muted">{emptyText}</p> : null
  return <ul data-running-commands className="flex min-w-0 flex-col">
    {commands.map(command => <RunningCommandRow key={command.execId} sessionId={sessionId} command={command} onChanged={() => void reload()} />)}
  </ul>
})

/** Compact trigger for Chat's status row; the list opens above it. */
const RunningCommands = memo(function RunningCommands({ sessionId, count }: { sessionId: string; count: number }) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<{ offset: number; maxWidth: number; anchorTop: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useEffect(() => { if (count <= 0) setOpen(false) }, [count])
  // The trigger can sit anywhere in Chat's status row: shift the popover sideways to stay inside
  // the Chat pane and the viewport, and cap its height at the room above the trigger.
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return }
    let frame = 0
    let last = ''
    const update = () => {
      const anchor = root.current, menu = popup.current
      if (anchor && menu) {
        const viewport = readHorizontalViewportBounds()
        const chat = anchor.closest<HTMLElement>('.foxwarm-chat-root')?.getBoundingClientRect()
        const clipped = chat ? { left: Math.max(viewport.left, chat.left), right: Math.min(viewport.right, chat.right) } : viewport
        const bounds = clipped.right > clipped.left ? clipped : viewport
        const anchorRect = anchor.getBoundingClientRect()
        const width = menu.getBoundingClientRect().width
        const geometry = [anchorRect.left, anchorRect.right, anchorRect.top, width, bounds.left, bounds.right].join(':')
        if (geometry !== last) {
          last = geometry
          const next = clampAnchoredMenuHorizontally({ anchorLeft: anchorRect.left, anchorRight: anchorRect.right, menuWidth: width, viewport: bounds, align: 'start' })
          setPlacement({ offset: next.offset, maxWidth: next.maxWidth, anchorTop: anchorRect.top })
        }
      }
      frame = window.requestAnimationFrame(update)
    }
    update()
    return () => window.cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  if (count <= 0) return null
  return <div ref={root} data-running-commands-control className="relative inline-flex min-w-0">
    <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}
      className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-sm text-fw-text-muted transition-colors hover:bg-fw-hover hover:text-fw-text-strong focus-visible:underline">
      {count === 1 ? '1 running command' : `${count} running commands`}
    </button>
    {open && <div ref={popup} role="dialog" aria-label="Running commands" data-running-commands-popover
      style={{
        transform: `translateX(${placement?.offset ?? 0}px)`,
        visibility: placement ? 'visible' : 'hidden',
        maxWidth: placement ? placement.maxWidth : undefined,
        maxHeight: placement ? `min(24rem, 60dvh, calc(${Math.round(placement.anchorTop)}px - var(--foxwarm-safe-area-top) - ${MENU_VIEWPORT_GUTTER * 2}px))` : undefined,
      }}
      className="absolute bottom-full left-0 z-[60] mb-2 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-fw-border bg-fw-surface px-4 py-2 text-sm text-fw-text shadow-xl">
      <RunningCommandList sessionId={sessionId} active={open} revision={count} emptyText="No commands are running." />
    </div>}
  </div>
})

export default RunningCommands

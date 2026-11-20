import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import { formatCompactDuration } from '../usageTiming'

export interface RunningCommand {
  execId: string
  nodeId: string
  command?: string | null
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

const RunningCommandRow = memo(function RunningCommandRow({ sessionId, command, onChanged }: { sessionId: string; command: RunningCommand; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(!!command.stopRequested)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { if (command.stopRequested) setStopping(true) }, [command.stopRequested])
  const text = command.command || command.execId
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
    <div className="flex min-w-0 items-start gap-2">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={expanded ? undefined : text}
        className={`min-w-0 flex-1 text-left font-mono text-xs text-fw-text-strong hover:opacity-80 focus-visible:underline ${expanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>
        {text}
      </button>
      <button type="button" data-running-command-stop disabled={stopping} onClick={() => void stop()}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-fw-text-muted transition-colors hover:bg-fw-hover hover:text-fw-danger focus-visible:underline disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fw-text-muted">
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
    <div className="flex min-w-0 flex-wrap gap-x-2 text-xs text-fw-text-muted">
      {command.nodeId !== 'master' && <span className="min-w-0 truncate">{command.nodeId}</span>}
      <span>{formatCompactDuration(Math.max(0, command.elapsedMs))}</span>
    </div>
    {problem && <p role="alert" className="text-xs text-fw-danger">{problem}</p>}
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
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (count <= 0) setOpen(false) }, [count])
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
    {open && <div role="dialog" aria-label="Running commands" className="absolute bottom-full left-0 z-[60] mb-2 max-h-[min(24rem,60dvh)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-fw-border bg-fw-surface px-4 py-2 text-sm text-fw-text shadow-xl">
      <RunningCommandList sessionId={sessionId} active={open} revision={count} emptyText="No commands are running." />
    </div>}
  </div>
})

export default RunningCommands

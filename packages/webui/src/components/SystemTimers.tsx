import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlarmClock, Bot, ChevronRight, Code2, ExternalLink, ListFilter, MessageSquare, Pause, Pencil, Play, Search, Trash2, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { webUiRealtime } from '../realtime'
import JsonInspectorDialog from './JsonInspectorDialog'
import {
  TIMER_OUTCOME_LABELS, TIMER_STATE_OPTIONS, buildTimerUpdate, filterTimers, formatTimerTime, lastTimerRun, orderTimers, timerAction,
  timerOutcomeTone, timerOwnerAgent, timerState, timerSummary, timerTarget, toLocalInput,
  type TimerAction, type TimerEditDraft, type TimerOwner, type TimerRow, type TimerRun, type TimerStateFilter,
} from '../systemTimers'

async function timerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`, init ? { ...init, headers: { 'Content-Type': 'application/json' } } : undefined)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Timer request failed (${response.status})`)
  return payload as T
}

const loadTimers = (sessionId?: string) =>
  timerRequest<{ timers: TimerRow[] }>(`/timers${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`).then(payload => payload.timers || [])

/** Reloads on timer changes and firings while mounted; the shared socket is already open for System. */
function useTimerList(sessionId?: string) {
  const [timers, setTimers] = useState<TimerRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await loadTimers(sessionId)
      if (current !== generation.current) return
      setTimers(next); setError('')
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoaded(true)
    }
  }, [sessionId])
  useEffect(() => {
    setLoaded(false); void reload()
    let pending: number | null = null
    const schedule = () => { if (pending === null) pending = window.setTimeout(() => { pending = null; void reload() }, 250) }
    const unsubscribe = webUiRealtime.subscribeSessionList([], {
      onOpen: schedule,
      onMessage: message => { if (message.type === 'timers-changed') schedule() },
    })
    return () => { if (pending !== null) window.clearTimeout(pending); unsubscribe(); generation.current++ }
  }, [reload])
  return { timers, loaded, error, reload, setTimers }
}

function useMinuteClock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  return now
}

const toneClasses = {
  success: 'bg-fw-success-surface text-fw-success',
  danger: 'bg-fw-danger-surface text-fw-danger',
  warning: 'bg-fw-warning-surface text-fw-warning',
  muted: 'bg-fw-surface-sunken text-fw-text-muted',
  active: 'bg-fw-accent-surface text-fw-accent',
}
const Badge = ({ tone, children, title }: { tone: keyof typeof toneClasses; children: ReactNode; title?: string }) =>
  <span title={title} className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClasses[tone]}`}>{children}</span>

const ActionIcon = ({ timer }: { timer: TimerRow }) => timerAction(timer) === 'toolscript'
  ? <Code2 aria-label="ToolScript" className="h-4 w-4 shrink-0 text-fw-special" />
  : <MessageSquare aria-label="Message" className="h-4 w-4 shrink-0 text-fw-accent" />

function scheduleText(timer: TimerRow, now: number) {
  if (timer.paused) return timer.mode === 'cron' ? `Repeats ${timer.cron} · paused` : `Once at ${timer.at ? formatTimerTime(timer.at, now) : '—'} · paused`
  if (timer.mode === 'cron') return `Repeats ${timer.cron} · ${timer.nextRunAt ? `next ${formatTimerTime(timer.nextRunAt, now)}` : 'not scheduled'}`
  return timer.at ? `Once at ${formatTimerTime(timer.at, now)}` : 'Once'
}

function StateBadge({ timer }: { timer: TimerRow }) {
  const state = timerState(timer)
  return state === 'paused' ? <Badge tone="warning">Paused</Badge> : state === 'scheduled' ? <Badge tone="active">Scheduled</Badge> : <Badge tone="muted">Not scheduled</Badge>
}

function RunBadge({ run }: { run?: TimerRun }) {
  if (!run) return <Badge tone="muted">No runs yet</Badge>
  return <Badge tone={timerOutcomeTone(run.outcome)} title={run.error}>{TIMER_OUTCOME_LABELS[run.outcome] || run.outcome}</Badge>
}

function TimerRowCard({ timer, owner, selected, now, onSelect }: { timer: TimerRow; owner?: TimerOwner; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} data-system-timer-id={timer.id} data-system-timer-selected={selected || undefined}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selected ? 'border-fw-accent-border bg-fw-accent-section' : 'border-fw-border bg-fw-surface hover:bg-fw-hover'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <ActionIcon timer={timer} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fw-text-strong">{timerSummary(timer)}</span>
        <StateBadge timer={timer} />
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-fw-text-muted">
        <span className="min-w-0 truncate">{scheduleText(timer, now)}</span>
        <span className="min-w-0 truncate"><Bot className="mr-1 inline h-3 w-3" />{owner?.displayName || timer.sessionId}</span>
        <RunBadge run={lastTimerRun(timer)} />
      </div>
    </button>
  )
}

const Field = ({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-1 text-xs">
    <dt className="text-fw-text-muted">{label}</dt>
    <dd className={`min-w-0 break-words text-fw-text-strong ${mono ? 'font-mono' : ''}`}>{children}</dd>
  </div>
)

const sectionClass = 'mt-4 border-t border-fw-border-muted pt-4'
const headingClass = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted'
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-fw-border px-2.5 py-1.5 text-xs font-medium text-fw-text hover:bg-fw-hover disabled:opacity-40'

function TimerEditor({ timer, onCancel, onSave }: { timer: TimerRow; onCancel: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState<'keep' | 'cron' | 'at' | 'after'>('keep')
  const [cron, setCron] = useState(timer.cron || '')
  const [local, setLocal] = useState(toLocalInput(timer.at))
  const [seconds, setSeconds] = useState('3600')
  const [message, setMessage] = useState(timer.message || '')
  const [script, setScript] = useState(JSON.stringify(timer.script || {}, null, 2))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const draft: TimerEditDraft = {
      schedule: kind === 'cron' ? { kind, cron } : kind === 'at' ? { kind, local } : kind === 'after' ? { kind, seconds } : { kind },
      ...(timerAction(timer) === 'message' ? { message } : { script }),
    }
    let body: Record<string, unknown>
    try { body = buildTimerUpdate(timer, draft) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    setSaving(true); setError('')
    try { await onSave(body) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setSaving(false) }
  }
  const input = 'w-full rounded-md border border-fw-border bg-fw-surface px-2.5 py-1.5 text-xs text-fw-text-strong outline-none focus:border-fw-accent-border'
  return (
    <form onSubmit={submit} className={sectionClass} data-system-timer-editor>
      <h3 className={headingClass}>Edit timer</h3>
      <label className="mt-2 block text-xs text-fw-text-muted">Schedule
        <select aria-label="Schedule" value={kind} onChange={event => setKind(event.target.value as typeof kind)} className={`${input} mt-1`}>
          <option value="keep">Keep current schedule</option>
          <option value="cron">Repeat on a cron schedule</option>
          <option value="at">Once at a date and time</option>
          <option value="after">Once after a delay</option>
        </select>
      </label>
      {kind === 'cron' ? <input aria-label="Cron schedule" value={cron} onChange={event => setCron(event.target.value)} placeholder="0 9 * * 1-5" className={`${input} mt-2 font-mono`} /> : null}
      {kind === 'at' ? <input aria-label="Date and time" type="datetime-local" value={local} onChange={event => setLocal(event.target.value)} className={`${input} mt-2`} /> : null}
      {kind === 'after' ? <label className="mt-2 flex items-center gap-2 text-xs text-fw-text-muted"><input aria-label="Delay in seconds" type="number" min="1" value={seconds} onChange={event => setSeconds(event.target.value)} className={input} />seconds</label> : null}
      {timerAction(timer) === 'message' ? (
        <label className="mt-3 block text-xs text-fw-text-muted">Message
          <textarea aria-label="Message" value={message} onChange={event => setMessage(event.target.value)} rows={4} className={`${input} mt-1`} />
        </label>
      ) : (
        <label className="mt-3 block text-xs text-fw-text-muted">Script settings
          <textarea aria-label="Script settings" value={script} onChange={event => setScript(event.target.value)} rows={7} spellCheck={false} className={`${input} mt-1 font-mono`} />
          <span className="mt-1 block text-[11px]">Replaces the whole script: code or filePath, node, args, mode, timeoutSecs.</span>
        </label>
      )}
      {error ? <p role="alert" className="mt-2 text-xs text-fw-danger">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onCancel} className={`${buttonClass} flex-1`}>Cancel</button>
        <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-fw-text-strong px-2.5 py-1.5 text-xs font-medium text-fw-surface disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

function TimerInspector({ timer, owner, now, onInspectSession, onOpenSession, onChanged, onDeleted }: {
  timer: TimerRow | null
  owner?: TimerOwner
  now: number
  onInspectSession: (sessionId: string) => void
  onOpenSession: (sessionId: string) => void
  onChanged: (timer: TimerRow) => void
  onDeleted: (timerId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [run, setRun] = useState<{ runId: string; text: string; loading: boolean } | null>(null)
  useEffect(() => { setEditing(false); setConfirmDelete(false); setError('') }, [timer?.id])
  if (!timer) {
    return (
      <aside className="rounded-xl border border-dashed border-fw-border-strong bg-fw-surface/60 p-6 text-center">
        <AlarmClock className="mx-auto h-6 w-6 text-fw-text" />
        <h3 className="mt-3 text-sm font-semibold text-fw-text-strong">Select a timer</h3>
        <p className="mt-1 text-xs leading-5 text-fw-text-muted">See its schedule and recent results, or pause, edit or delete it.</p>
      </aside>
    )
  }
  const update = async (body: Record<string, unknown>) => {
    const payload = await timerRequest<{ timer: TimerRow }>(`/timers/${encodeURIComponent(timer.id)}`, { method: 'PATCH', body: JSON.stringify({ sessionId: timer.sessionId, ...body }) })
    onChanged(payload.timer)
  }
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const remove = () => act(async () => {
    await timerRequest(`/timers/${encodeURIComponent(timer.id)}`, { method: 'DELETE', body: JSON.stringify({ sessionId: timer.sessionId }) })
    onDeleted(timer.id)
  })
  const openRun = async (runId: string) => {
    setRun({ runId, text: '', loading: true })
    try {
      const payload = await timerRequest<{ run: unknown }>(`/timers/${encodeURIComponent(timer.id)}/runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(timer.sessionId)}`)
      setRun(current => current?.runId === runId ? { runId, text: JSON.stringify(payload.run, null, 2), loading: false } : current)
    } catch (cause) {
      setRun(current => current?.runId === runId ? { runId, text: JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }, null, 2), loading: false } : current)
    }
  }
  const script = timer.script || {}
  const runs = timer.recentRuns || []
  return (
    <aside className="min-w-0 rounded-xl border border-fw-border bg-fw-surface p-4 xl:sticky xl:top-4 xl:self-start" data-system-timer-inspector={timer.id}>
      <div className="flex items-start gap-2">
        <ActionIcon timer={timer} />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-sm font-semibold text-fw-text-strong">{timerSummary(timer)}</h2>
          <p className="mt-0.5 font-mono text-[11px] text-fw-text-muted">{timer.id}</p>
        </div>
        <StateBadge timer={timer} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => act(() => update({ paused: !timer.paused }))} className={buttonClass} data-system-timer-pause>
          {timer.paused ? <><Play className="h-3.5 w-3.5" /> Resume</> : <><Pause className="h-3.5 w-3.5" /> Pause</>}
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(true); setConfirmDelete(false) }} className={buttonClass}><Pencil className="h-3.5 w-3.5" /> Edit</button>
        <button type="button" disabled={busy} onClick={() => { setConfirmDelete(true); setEditing(false) }} className={`${buttonClass} border-fw-danger-border text-fw-danger hover:bg-fw-danger-surface`}><Trash2 className="h-3.5 w-3.5" /> Delete</button>
      </div>
      {timer.paused && timer.mode === 'once' && timer.at && timer.at <= now ? <p className="mt-2 text-xs text-fw-text-muted">Its time has passed. Resuming fires it once.</p> : null}
      {confirmDelete ? (
        <div className="mt-3 rounded-lg border border-fw-danger-border bg-fw-danger-surface/50 p-3" data-system-timer-delete-confirm>
          <p className="text-xs leading-5 text-fw-danger">Delete this timer? It will not fire again. A run already in progress is not stopped.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className={`${buttonClass} flex-1`}>Cancel</button>
            <button type="button" disabled={busy} onClick={() => { void remove() }} className="flex-1 rounded-md bg-fw-danger px-2 py-1.5 text-xs font-medium text-fw-text-inverse disabled:opacity-40">Delete timer</button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-fw-danger">{error}</p> : null}
      {editing ? <TimerEditor key={timer.id} timer={timer} onCancel={() => setEditing(false)} onSave={async body => { await update(body); setEditing(false) }} /> : null}

      <section className={sectionClass}>
        <h3 className={headingClass}>Schedule</h3>
        <dl className="mt-1">
          {timer.mode === 'cron' ? <Field label="Repeats" mono>{timer.cron}</Field> : <Field label="Once at">{timer.at ? formatTimerTime(timer.at, now) : '—'}</Field>}
          <Field label="Next run">{timer.paused ? 'Paused' : timer.nextRunAt ? formatTimerTime(timer.nextRunAt, now) : 'Not scheduled'}</Field>
          {timer.lastTriggeredAt ? <Field label="Last fired">{formatTimerTime(timer.lastTriggeredAt, now)}</Field> : null}
        </dl>
      </section>

      <section className={sectionClass}>
        <h3 className={headingClass}>Owner and action</h3>
        <dl className="mt-1">
          <Field label="Owner">
            <span className="flex min-w-0 items-center gap-1">
              <button type="button" onClick={() => onInspectSession(timer.sessionId)} className="min-w-0 truncate text-left text-fw-accent hover:underline" data-system-timer-owner={timer.sessionId}>{owner?.displayName || timer.sessionId}</button>
              <button type="button" aria-label="Open owner session" title="Open session" onClick={() => onOpenSession(timer.sessionId)} className="rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text"><ExternalLink className="h-3 w-3" /></button>
            </span>
          </Field>
          <Field label="Agent">{timerOwnerAgent(timer, owner)}</Field>
          <Field label="Action">{timerAction(timer) === 'toolscript' ? 'ToolScript' : 'Message'}</Field>
          <Field label="Target">{timerTarget(timer)}</Field>
          {timerAction(timer) === 'toolscript' ? <>
            {script.filePath ? <Field label="Script file" mono>{script.filePath}</Field> : null}
            <Field label="Source node">{script.code !== undefined ? 'Inline' : script.node || 'Owner’s current node'}</Field>
            <Field label="Timeout">{`${script.timeoutSecs ?? 30}s`}</Field>
            {script.code !== undefined ? <Field label="Code"><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-fw-surface-sunken p-2 font-mono text-[11px]">{script.code}</pre></Field> : null}
          </> : <Field label="Message"><span className="whitespace-pre-wrap">{timer.message}</span></Field>}
        </dl>
      </section>

      <section className={sectionClass}>
        <h3 className={headingClass}>Recent results</h3>
        {runs.length ? (
          <ol className="mt-2 space-y-1.5" data-system-timer-runs>
            {runs.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="rounded-lg border border-fw-border-muted px-2.5 py-1.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <RunBadge run={entry} />
                  <span className="min-w-0 flex-1 truncate text-fw-text-muted">{formatTimerTime(entry.at, now)}</span>
                  {entry.runId ? <button type="button" onClick={() => { void openRun(entry.runId!) }} className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] text-fw-accent hover:underline" data-system-timer-run={entry.runId}>{entry.runId}<ChevronRight className="h-3 w-3" /></button> : null}
                </div>
                {entry.error ? <p className="mt-1 break-words text-fw-danger">{entry.error}</p> : null}
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-xs text-fw-text-muted">{timer.mode === 'cron' ? 'It has not fired yet.' : 'A one-time timer is removed after it fires.'}</p>}
      </section>
      {run ? <JsonInspectorDialog title={`Script run ${run.runId}`} text={run.text} loading={run.loading} onClose={() => setRun(null)} /> : null}
    </aside>
  )
}

function useTimerOwners(timers: TimerRow[]) {
  const [owners, setOwners] = useState<Record<string, TimerOwner>>({})
  const ids = useMemo(() => [...new Set(timers.map(timer => timer.sessionId))].sort(), [timers])
  useEffect(() => {
    if (!ids.length) return
    const controller = new AbortController()
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100))
    void Promise.all(chunks.map(async chunk => {
      const response = await fetch(`${API_BASE_PATH}/session-list/by-id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: chunk, includePaths: false }), signal: controller.signal })
      if (!response.ok) return []
      const payload = await response.json() as { results?: Array<{ requestedId: string; session?: { displayName?: string; agent?: string } | null }> }
      return (payload.results || []).flatMap(item => item.session ? [[item.requestedId, { displayName: item.session.displayName?.trim() || undefined, agent: item.session.agent }] as const] : [])
    })).then(results => { if (!controller.signal.aborted) setOwners(Object.fromEntries(results.flat())) }).catch(() => {})
    return () => controller.abort()
  }, [ids.join('\0')])
  return owners
}

export interface SystemTimersProps {
  /** Shows only this Session's timers when set. */
  sessionFilter: string | null
  onSessionFilterChange: (sessionId: string | null) => void
  onInspectSession: (sessionId: string) => void
  onOpenSession: (sessionId: string) => void
}

export default function SystemTimers({ sessionFilter: sessionId, onSessionFilterChange, onInspectSession, onOpenSession }: SystemTimersProps) {
  const { timers, loaded, error, reload, setTimers } = useTimerList()
  const owners = useTimerOwners(timers)
  const now = useMinuteClock()
  const [query, setQuery] = useState('')
  const [agent, setAgent] = useState<string | null>(null)
  const [action, setAction] = useState<TimerAction | null>(null)
  const [state, setState] = useState<TimerStateFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Choosing a Session's timers starts from its complete list.
  useEffect(() => {
    if (!sessionId) return
    setQuery(''); setAgent(null); setAction(null); setState('all')
  }, [sessionId])

  const agents = useMemo(() => [...new Set(timers.map(timer => timerOwnerAgent(timer, owners[timer.sessionId])))].sort(), [timers, owners])
  const visible = useMemo(() => orderTimers(filterTimers(timers, owners, { query, agent, action, state, sessionId })), [timers, owners, query, agent, action, state, sessionId])
  useEffect(() => {
    if (selectedId && visible.some(timer => timer.id === selectedId)) return
    setSelectedId(visible[0]?.id || null)
  }, [visible, selectedId])
  const selected = timers.find(timer => timer.id === selectedId) || null
  const pausedCount = timers.filter(timer => timer.paused).length
  const failingCount = timers.filter(timer => lastTimerRun(timer)?.outcome === 'failed').length
  const select = 'h-9 w-full min-w-0 rounded-lg border sm:w-auto border-transparent bg-transparent px-3 text-xs font-medium text-fw-text outline-none hover:bg-fw-hover focus:border-fw-accent-border'

  return (
    <div className="space-y-4" data-system-timers>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-1">
          <label className="relative w-full sm:w-64 sm:shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fw-text-muted" />
            <input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search timers" placeholder="Search timers…" className="h-9 w-full rounded-lg border border-fw-border bg-fw-surface py-0 pl-9 pr-3 text-xs text-fw-text-strong outline-none hover:bg-fw-hover focus:border-fw-accent-border" />
          </label>
          <div className="grid w-full grid-cols-3 gap-1 sm:flex sm:w-auto sm:items-center">
          <select aria-label="Filter timers by agent" value={agent || ''} onChange={event => setAgent(event.target.value || null)} className={select}>
            <option value="">All agents</option>
            {agents.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <select aria-label="Filter timers by action" value={action || ''} onChange={event => setAction((event.target.value || null) as TimerAction | null)} className={select}>
            <option value="">All actions</option>
            <option value="message">Message</option>
            <option value="toolscript">ToolScript</option>
          </select>
          <select aria-label="Filter timers by state" value={state} onChange={event => setState(event.target.value as TimerStateFilter)} className={select}>
            {TIMER_STATE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          </div>
          {sessionId ? (
            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-fw-accent-surface px-2.5 py-1 text-xs text-fw-accent" data-system-timers-session-filter={sessionId}>
              <ListFilter className="h-3 w-3" /><span className="truncate">Session {owners[sessionId]?.displayName || sessionId}</span>
              <button type="button" aria-label="Show timers for all sessions" onClick={() => onSessionFilterChange(null)} className="rounded-full p-0.5 hover:bg-fw-hover"><X className="h-3 w-3" /></button>
            </span>
          ) : null}
        </div>
        <div className="text-xs text-fw-text-muted" data-system-summary="timers">
          <strong className="font-semibold tabular-nums text-fw-text-strong">{timers.length}</strong> timers · <strong className="font-semibold tabular-nums text-fw-text-strong">{pausedCount}</strong> paused · <strong className="font-semibold tabular-nums text-fw-text-strong">{failingCount}</strong> failing
        </div>
      </div>
      {error ? <div className="flex items-center justify-between gap-3 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger"><span>{error}</span><button type="button" onClick={() => { void reload() }} className="font-medium underline">Retry</button></div> : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <main className="min-w-0 space-y-2" data-system-timer-list>
          {visible.map(timer => <TimerRowCard key={timer.id} timer={timer} owner={owners[timer.sessionId]} selected={timer.id === selectedId} now={now} onSelect={() => setSelectedId(timer.id)} />)}
          {loaded && visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-fw-border-strong py-10 text-center text-sm text-fw-text-muted">{timers.length ? 'No timers match these filters.' : 'No timers yet. Sessions create them with the timer tools or /timer.'}</div>
          ) : null}
        </main>
        <TimerInspector
          timer={selected}
          owner={selected ? owners[selected.sessionId] : undefined}
          now={now}
          onInspectSession={onInspectSession}
          onOpenSession={onOpenSession}
          onChanged={timer => setTimers(current => current.map(item => item.id === timer.id ? timer : item))}
          onDeleted={timerId => setTimers(current => current.filter(item => item.id !== timerId))}
        />
      </div>
    </div>
  )
}

/** Session inspector section: this Session's timers, with a link to System › Timers. */
export function SessionTimersSection({ sessionId, onShowTimers }: { sessionId: string; onShowTimers: (sessionId: string) => void }) {
  const { timers, loaded, error } = useTimerList(sessionId)
  const now = useMinuteClock()
  const ordered = useMemo(() => orderTimers(timers), [timers])
  return (
    <section className="mt-4 border-t border-fw-border-muted pt-4" data-session-timers={sessionId}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={headingClass}>Timers</h3>
        <button type="button" onClick={() => onShowTimers(sessionId)} className="inline-flex items-center gap-0.5 text-xs font-medium text-fw-accent hover:underline" data-session-timers-open>
          View in Timers<ChevronRight className="h-3 w-3" />
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-fw-danger">{error}</p> : !loaded ? null : ordered.length === 0 ? <p className="mt-2 text-xs text-fw-text-muted">No timers</p> : (
        <ul className="mt-2 space-y-1.5">
          {ordered.slice(0, 5).map(timer => (
            <li key={timer.id} className="rounded-lg border border-fw-border px-2.5 py-1.5 text-xs" data-session-timer-id={timer.id}>
              <div className="flex min-w-0 items-center gap-2"><ActionIcon timer={timer} /><span className="min-w-0 flex-1 truncate text-fw-text-strong">{timerSummary(timer)}</span>{timer.paused ? <Badge tone="warning">Paused</Badge> : null}</div>
              <div className="mt-0.5 truncate pl-6 text-fw-text-muted">{scheduleText(timer, now)}</div>
            </li>
          ))}
          {ordered.length > 5 ? <li className="text-xs text-fw-text-muted">{ordered.length - 5} more</li> : null}
        </ul>
      )}
    </section>
  )
}

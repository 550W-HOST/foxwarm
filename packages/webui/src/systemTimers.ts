// System › Timers: list projection, filters and edit validation.

export type TimerRunOutcome = 'delivered' | 'failed' | 'completed' | 'paused' | 'skipped'

export type TimerRun = {
  at: number
  outcome: TimerRunOutcome
  runId?: string
  error?: string
}

export type TimerScript = {
  code?: string
  filePath?: string
  node?: string
  mode?: string
  timeoutSecs?: number
  args?: unknown
  argsJson?: string
}

export type TimerRow = {
  id: string
  sessionId: string
  action?: 'message' | 'toolscript'
  message?: string
  script?: TimerScript
  cron?: string
  at?: number
  mode: 'cron' | 'once'
  nextRunAt: number | null
  paused: boolean
  newSession?: boolean
  sessionPrefix?: string
  agentName?: string
  createdAt?: number
  lastTriggeredAt?: number
  recentRuns?: TimerRun[]
}

export type TimerAction = 'message' | 'toolscript'
export type TimerStateFilter = 'all' | 'scheduled' | 'paused' | 'failing' | 'inactive'
export type TimerOwner = { displayName?: string; agent?: string }

export const TIMER_STATE_OPTIONS: Array<{ id: TimerStateFilter; label: string }> = [
  { id: 'all', label: 'All states' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'paused', label: 'Paused' },
  { id: 'failing', label: 'Last run failed' },
  { id: 'inactive', label: 'Not scheduled' },
]

export const timerAction = (timer: TimerRow): TimerAction => timer.action === 'toolscript' ? 'toolscript' : 'message'

/** Agent of the owner Session: the catalog's answer when known, otherwise its ID prefix. */
export const timerOwnerAgent = (timer: TimerRow, owner?: TimerOwner) =>
  owner?.agent || (timer.sessionId.includes('/') ? timer.sessionId.slice(0, timer.sessionId.indexOf('/')) : 'main')

export const lastTimerRun = (timer: TimerRow): TimerRun | undefined => timer.recentRuns?.[0]

export function timerState(timer: TimerRow): Exclude<TimerStateFilter, 'all' | 'failing'> {
  if (timer.paused) return 'paused'
  return timer.nextRunAt ? 'scheduled' : 'inactive'
}

export const timerRunFailed = (timer: TimerRow) => lastTimerRun(timer)?.outcome === 'failed'

/** One-line summary of what the timer does. */
export function timerSummary(timer: TimerRow): string {
  if (timerAction(timer) === 'message') return (timer.message || '').replace(/\s+/g, ' ').trim() || 'Empty message'
  const script = timer.script || {}
  if (script.code !== undefined) {
    const first = script.code.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#'))
    return first ? `Inline script: ${first}` : 'Inline script'
  }
  return `Script file ${script.filePath || ''}`.trim()
}

export function timerTarget(timer: TimerRow): string {
  if (timerAction(timer) === 'toolscript') return 'Runs for the owner session'
  if (!timer.newSession) return 'Owner session'
  return `New session in ${timer.agentName || 'main'} · prefix ${timer.sessionPrefix || 'timer'}`
}

export const TIMER_OUTCOME_LABELS: Record<TimerRunOutcome, string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  completed: 'Completed',
  paused: 'Script paused',
  skipped: 'Skipped · previous run still active',
}

export const timerOutcomeTone = (outcome: TimerRunOutcome) =>
  outcome === 'failed' ? 'danger' : outcome === 'paused' || outcome === 'skipped' ? 'warning' : 'success'

export function filterTimers(
  timers: TimerRow[],
  owners: Record<string, TimerOwner>,
  filters: { query: string; agent: string | null; action: TimerAction | null; state: TimerStateFilter; sessionId: string | null },
): TimerRow[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return timers.filter(timer => {
    if (filters.sessionId && timer.sessionId !== filters.sessionId) return false
    if (filters.agent && timerOwnerAgent(timer, owners[timer.sessionId]) !== filters.agent) return false
    if (filters.action && timerAction(timer) !== filters.action) return false
    if (filters.state === 'failing' ? !timerRunFailed(timer) : filters.state !== 'all' && timerState(timer) !== filters.state) return false
    if (!query) return true
    const script = timer.script || {}
    return [timer.id, timer.sessionId, owners[timer.sessionId]?.displayName, timer.message, timer.cron, script.code, script.filePath, script.node, timer.agentName, timer.sessionPrefix]
      .some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(query))
  })
}

/** Paused timers last; then by next run, soonest first; unscheduled after scheduled. */
export function orderTimers(timers: TimerRow[]): TimerRow[] {
  const rank = (timer: TimerRow) => timer.paused ? 2 : timer.nextRunAt ? 0 : 1
  return [...timers].sort((left, right) => rank(left) - rank(right)
    || (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER)
    || (left.createdAt ?? 0) - (right.createdAt ?? 0)
    || left.id.localeCompare(right.id))
}

export type TimerScheduleDraft =
  | { kind: 'keep' }
  | { kind: 'cron'; cron: string }
  | { kind: 'at'; local: string }
  | { kind: 'after'; seconds: string }

export type TimerEditDraft = {
  schedule: TimerScheduleDraft
  message?: string
  script?: string
}

/**
 * Builds the update request from an edit draft: only changed fields, with exactly one
 * schedule field when the schedule changes. Throws a user-facing message when invalid.
 */
export function buildTimerUpdate(timer: TimerRow, draft: TimerEditDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const schedule = draft.schedule
  if (schedule.kind === 'cron') {
    if (!schedule.cron.trim()) throw new Error('Enter a cron schedule.')
    if (schedule.cron.trim() !== timer.cron) body.cron = schedule.cron.trim()
  } else if (schedule.kind === 'at') {
    const at = new Date(schedule.local).getTime()
    if (!schedule.local || !Number.isFinite(at)) throw new Error('Choose a date and time.')
    body.at = at
  } else if (schedule.kind === 'after') {
    const seconds = Number(schedule.seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Enter a positive number of seconds.')
    body.afterSeconds = seconds
  }
  if (timerAction(timer) === 'message') {
    if (draft.message !== undefined && draft.message !== (timer.message || '')) {
      if (!draft.message.trim()) throw new Error('Enter a message.')
      body.message = draft.message
    }
  } else if (draft.script !== undefined) {
    let script: unknown
    try {
      script = JSON.parse(draft.script)
    } catch {
      throw new Error('The script settings must be a JSON object.')
    }
    if (!script || typeof script !== 'object' || Array.isArray(script)) throw new Error('The script settings must be a JSON object.')
    if (JSON.stringify(script) !== JSON.stringify(timer.script || {})) body.script = script
  }
  if (!Object.keys(body).length) throw new Error('No changes to save.')
  return body
}

/** Local `datetime-local` value for an epoch time. */
export function toLocalInput(epoch?: number | null): string {
  if (!epoch) return ''
  const date = new Date(epoch)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTimerTime(epoch: number, now = Date.now()): string {
  const absolute = new Date(epoch).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const diff = epoch - now
  const span = Math.abs(diff)
  const unit = span < 60_000 ? '<1m' : span < 3_600_000 ? `${Math.round(span / 60_000)}m` : span < 86_400_000 ? `${Math.round(span / 3_600_000)}h` : `${Math.round(span / 86_400_000)}d`
  return `${absolute} (${diff >= 0 ? `in ${unit}` : `${unit} ago`})`
}

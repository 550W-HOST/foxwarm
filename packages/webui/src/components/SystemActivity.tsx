import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, ListFilter, Search, X } from 'lucide-react'
import { webUiRealtime } from '../realtime'
import {
  ACTIVITY_KINDS, ACTIVITY_ORIGINS, ACTIVITY_OUTCOMES, OUTCOME_LABELS, activityInitiatorLabel, activityToolLabel, loadActivity,
  type ActivityFilters, type ActivityItem, type ActivityPage,
} from '../activity'
import { openSessionAtSeq } from '../chatViewportState'

type ActivityPeriod = 'day' | 'week' | 'month' | 'all'

const PERIODS: Array<{ id: ActivityPeriod; label: string; ms?: number }> = [
  { id: 'day', label: '24 hours', ms: 86_400_000 },
  { id: 'week', label: '7 days', ms: 7 * 86_400_000 },
  { id: 'month', label: '30 days', ms: 30 * 86_400_000 },
  { id: 'all', label: 'All' },
]

/** Filters that narrow the list to one subject; shown as removable chips. */
type Scope = Pick<ActivityFilters, 'sessionId' | 'tree' | 'agent' | 'executionAgent' | 'node' | 'tool' | 'initiator'>

const SCOPE_LABELS: Array<{ key: keyof Scope; label: (value: string, scope: Scope) => string }> = [
  { key: 'sessionId', label: (value, scope) => scope.tree ? `Session tree ${value}` : `Session ${value}` },
  { key: 'agent', label: value => `Agent ${value}` },
  { key: 'executionAgent', label: value => `Ran in Agent ${value}` },
  { key: 'node', label: value => `Node ${value}` },
  { key: 'tool', label: value => `Tool ${value}` },
  { key: 'initiator', label: value => `Started by ${value}` },
]

// Requests from elsewhere apply once, not again when the section remounts.
let appliedRequest = 0

const formatTime = (time: number) => {
  const date = new Date(time)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const formatDuration = (ms: number | null) => ms === null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

function OutcomeBadge({ item }: { item: ActivityItem }) {
  const ok = item.outcome === 'ok'
  const tone = ok ? 'text-fw-success' : item.outcome === 'denied' || item.outcome === 'error' ? 'text-fw-danger' : 'text-fw-warning'
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`} data-activity-outcome={item.outcome}>
      {OUTCOME_LABELS[item.outcome] || item.outcome}
      {item.approval && item.approval !== 'pending' ? <span className="rounded bg-fw-section px-1 text-[10px] text-fw-text-muted" title={item.approver ? `Decided by ${item.approver}` : undefined}>approval {item.approval}</span> : null}
    </span>
  )
}

function Detail({ item }: { item: ActivityItem }) {
  const rows: Array<[string, string]> = []
  if (item.summary) rows.push(['Arguments', item.summary])
  if (item.source) rows.push(['Tool', `${item.source}${item.server ? `:${item.server}` : ''} / ${item.tool}`])
  rows.push(['Node', item.node || 'Not recorded'])
  if (item.refs?.cwd) rows.push(['Working directory', item.refs.cwd])
  if (item.refs?.paths?.length) rows.push(['Files', item.refs.paths.join('\n')])
  if (item.refs?.execId) rows.push(['Execution', item.refs.execId])
  if (item.refs?.deliveries?.length) rows.push(['Delivered to', item.refs.deliveries.map(delivery => delivery.sessionId).join(', ')])
  if (item.rules?.length) rows.push(['Rules', item.rules.map(rule => `${rule.layer === 'global' ? 'Global' : rule.layer.replace(/^agent:/, 'Agent ')} · ${rule.id} · ${rule.effect}`).join('\n')])
  if (item.approval) rows.push(['Approval', `${item.approval}${item.approver ? ` by ${item.approver}` : ''}`])
  if (item.errorType && item.outcome !== 'ok') rows.push(['Error', item.errorType])
  if (item.agent) rows.push(['Agent when it ran', item.agent])
  if (item.currentAgent && item.currentAgent !== item.agent) rows.push(['Agent now', item.currentAgent])
  if (item.deleted && item.sessionId) rows.push(['Session', 'Deleted'])
  if (item.runId) rows.push(['Script run', item.runId])
  rows.push(['Started by', activityInitiatorLabel(item)])
  if (item.durationMs !== null) rows.push(['Duration', formatDuration(item.durationMs)])
  return (
    <dl className="grid grid-cols-[minmax(6rem,10rem)_1fr] gap-x-3 gap-y-1 px-4 pb-3 pl-10 text-[11px]" data-activity-detail>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fw-text-muted">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-fw-text">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface SystemActivityProps {
  /** Opens the section with these filters; a new nonce repeats the request. */
  request?: { filters: ActivityFilters; nonce: number } | null
  onOpenSession: (sessionId: string) => void
}

export default function SystemActivity({ request, onOpenSession }: SystemActivityProps) {
  const [period, setPeriod] = useState<ActivityPeriod>('week')
  const [kind, setKind] = useState<NonNullable<ActivityFilters['kind']>>('changes')
  const [outcome, setOutcome] = useState<string>('')
  const [origin, setOrigin] = useState<string>('')
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<Scope>({})
  const [page, setPage] = useState<ActivityPage | null>(null)
  const [extra, setExtra] = useState<ActivityItem[]>([])
  const [cursor, setCursor] = useState<ActivityPage['next']>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!request || request.nonce <= appliedRequest) return
    appliedRequest = request.nonce
    const { kind: requestedKind, outcome: requestedOutcome, origin: requestedOrigin, text: requestedText, from: _from, to: _to, ...rest } = request.filters
    setScope(rest)
    setKind(requestedKind || 'changes')
    setOutcome(requestedOutcome || '')
    setOrigin(requestedOrigin || '')
    setText(requestedText || ''); setSearch(requestedText || '')
    setPeriod('all')
  }, [request?.nonce])

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [text])

  const filters = useMemo<ActivityFilters>(() => {
    const ms = PERIODS.find(item => item.id === period)?.ms
    return {
      ...scope,
      from: ms ? Date.now() - ms : undefined,
      kind,
      outcome: (outcome || undefined) as ActivityFilters['outcome'],
      origin: origin || undefined,
      text: search || undefined,
    }
  }, [period, kind, outcome, origin, search, scope])
  const filtersKey = JSON.stringify({ ...filters, from: period })

  const reload = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await loadActivity(filters)
      if (current !== generation.current) return
      setPage(next); setExtra([]); setCursor(next.next); setError('')
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [filtersKey])

  useEffect(() => {
    void reload()
    let pending: number | null = null
    const schedule = () => { if (pending === null) pending = window.setTimeout(() => { pending = null; void reload() }, 1000) }
    const unsubscribe = webUiRealtime.subscribeSessionList([], {
      onOpen: schedule,
      onMessage: message => { if (message.type === 'activity-changed') schedule() },
    })
    return () => { if (pending !== null) window.clearTimeout(pending); unsubscribe(); generation.current++ }
  }, [reload])

  const loadMore = async () => {
    if (!cursor) return
    const current = generation.current
    setLoading(true)
    try {
      const next = await loadActivity(filters, cursor)
      if (current !== generation.current) return
      setExtra(items => [...items, ...next.items]); setCursor(next.next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const items = page ? [...page.items, ...extra] : []
  const narrow = (patch: Scope) => setScope(value => ({ ...value, ...patch }))
  const chips = SCOPE_LABELS.filter(entry => typeof scope[entry.key] === 'string' && scope[entry.key])
  const coverage = page?.coverage
  const segment = (active: boolean) => `rounded-md px-3 py-1 text-xs font-medium ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`
  const select = 'h-9 min-w-0 rounded-lg border border-transparent bg-transparent px-3 text-xs font-medium text-fw-text outline-none hover:bg-fw-hover focus:border-fw-accent-border'
  const cellLink = 'min-w-0 truncate text-left hover:text-fw-accent hover:underline'

  return (
    <div className="space-y-4" data-system-activity data-activity-kind={kind}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5" role="group" aria-label="Activity period">
            {PERIODS.map(item => (
              <button key={item.id} type="button" aria-pressed={period === item.id} data-activity-period={item.id} onClick={() => setPeriod(item.id)} className={segment(period === item.id)}>{item.label}</button>
            ))}
          </div>
          <select aria-label="Kind of activity" value={kind} onChange={event => setKind(event.target.value as typeof kind)} className={select}>
            {ACTIVITY_KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <select aria-label="Result" value={outcome} onChange={event => setOutcome(event.target.value)} className={select}>
            {ACTIVITY_OUTCOMES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <select aria-label="Source" value={origin} onChange={event => setOrigin(event.target.value)} className={select}>
            {ACTIVITY_ORIGINS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fw-text-muted" />
            <input type="search" aria-label="Search activity" placeholder="Search" value={text} onChange={event => setText(event.target.value)} className="h-9 w-44 rounded-lg border border-fw-border bg-fw-surface pl-7 pr-2 text-xs text-fw-text-strong outline-none focus:border-fw-accent-border" />
          </label>
        </div>
        {coverage && !coverage.complete ? <span className="text-xs text-fw-text-muted" data-activity-coverage>Adding earlier activity…</span> : null}
      </div>
      {chips.length ? (
        <div className="flex flex-wrap gap-2 px-1">
          {chips.map(entry => (
            <span key={entry.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-fw-accent-surface px-2.5 py-1 text-xs text-fw-accent" data-activity-filter={entry.key}>
              <ListFilter className="h-3 w-3" /><span className="truncate">{entry.label(scope[entry.key] as string, scope)}</span>
              <button type="button" aria-label={`Remove filter ${entry.label(scope[entry.key] as string, scope)}`} onClick={() => setScope(value => { const next = { ...value }; delete next[entry.key]; if (entry.key === 'sessionId') delete next.tree; return next })} className="rounded-full p-0.5 hover:bg-fw-hover"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? <div className="flex items-center justify-between gap-3 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger"><span>{error}</span><button type="button" onClick={() => { void reload() }} className="font-medium underline">Retry</button></div> : null}

      <section className={`overflow-hidden rounded-xl border border-fw-border bg-fw-surface transition-opacity ${loading && !page ? 'opacity-60' : ''}`} data-activity-list>
        <table className="w-full table-fixed text-xs">
          <thead className="border-b border-fw-border-muted text-left text-[10px] text-fw-text-muted">
            <tr>
              <th className="w-36 px-4 py-2 font-medium">Time</th>
              <th className="w-48 px-2 py-2 font-medium">Session</th>
              <th className="hidden w-32 px-2 py-2 font-medium md:table-cell">Node</th>
              <th className="px-2 py-2 font-medium">Call</th>
              <th className="w-32 px-2 py-2 font-medium">Result</th>
              <th className="hidden w-40 px-4 py-2 font-medium lg:table-cell">Started by</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const open = expanded === item.key
              const session = item.currentSessionId || item.sessionId
              const seq = item.seq ?? undefined
              return [
                <tr key={item.key} className="border-t border-fw-border-muted align-top first:border-0 hover:bg-fw-hover/40" data-activity-row={item.key} data-activity-row-kind={item.kind}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-fw-text-muted">
                    <button type="button" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setExpanded(open ? null : item.key)} className="inline-flex items-center gap-1 hover:text-fw-text">
                      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <span title={new Date(item.startedAt).toLocaleString()}>{formatTime(item.startedAt)}</span>
                    </button>
                  </td>
                  <td className="px-2 py-2">
                    {session ? (
                      <div className="flex min-w-0 items-center gap-1">
                        <button type="button" onClick={() => narrow({ sessionId: session, tree: false })} title={`Show activity of ${session}`} className={`${cellLink} font-medium text-fw-text-strong`}>{item.title || session}</button>
                        {!item.deleted ? <button type="button" aria-label={`Open ${session} at this call`} title="Open in session" onClick={() => openSessionAtSeq(session, seq, onOpenSession)} className="shrink-0 rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-accent" data-activity-open={session}><ExternalLink className="h-3 w-3" /></button> : null}
                      </div>
                    ) : <span className="text-fw-text-muted">Outside sessions</span>}
                    {item.agent || item.currentAgent ? (
                      <button type="button" onClick={() => narrow({ executionAgent: item.agent || undefined })} className={`${cellLink} block text-[11px] text-fw-text-muted`} title="Agent when it ran">
                        {item.agent}{item.currentAgent && item.currentAgent !== item.agent ? ` → ${item.currentAgent}` : ''}{item.deleted ? ' · deleted' : ''}
                      </button>
                    ) : null}
                  </td>
                  <td className="hidden px-2 py-2 md:table-cell">
                    {item.node ? <button type="button" onClick={() => narrow({ node: item.node! })} className={`${cellLink} block text-fw-text`}>{item.node}</button> : <span className="text-fw-text-muted">—</span>}
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" onClick={() => narrow({ tool: item.tool })} className={`${cellLink} block font-medium text-fw-text-strong`}>{activityToolLabel(item)}{item.sub ? <span className="font-normal text-fw-text-muted"> · in script</span> : null}</button>
                    {item.summary ? <div className="truncate font-mono text-[11px] text-fw-text-muted" title={item.summary}>{item.summary}</div> : null}
                  </td>
                  <td className="px-2 py-2"><OutcomeBadge item={item} /></td>
                  <td className="hidden truncate px-4 py-2 text-fw-text-muted lg:table-cell" title={activityInitiatorLabel(item)}>{activityInitiatorLabel(item)}</td>
                </tr>,
                open ? <tr key={`${item.key}:detail`} className="bg-fw-section/40"><td colSpan={6}><Detail item={item} /></td></tr> : null,
              ]
            })}
            {page && !items.length ? <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-fw-text-muted">{kind === 'changes' ? 'No changes match these filters.' : 'No activity matches these filters.'}</td></tr> : null}
            {!page && !error ? <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-fw-text-muted">{loading ? 'Loading activity…' : ''}</td></tr> : null}
          </tbody>
        </table>
        {cursor ? (
          <div className="border-t border-fw-border-muted px-4 py-2">
            <button type="button" disabled={loading} onClick={() => { void loadMore() }} className="text-xs font-medium text-fw-accent hover:underline disabled:opacity-60" data-activity-more>{loading ? 'Loading…' : 'Show earlier activity'}</button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

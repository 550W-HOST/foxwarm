import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, ListFilter, X } from 'lucide-react'
import { useLocalDay, useUsageReport } from '../useUsageReport'
import { formatUsdCost } from '../usageCost'
import TokenUsageDetails, { formatUsageNumber } from './TokenUsageDetails'
import {
  MAX_USAGE_DAYS, USAGE_GROUPINGS, USAGE_PERIODS, toDateInput, usageBucketLabel, usageGroupDetail,
  usageGroupLabel, usageMetricValue, usageQuery, usageRange, usageRecordsBegin, usageSeries, usageTokens,
  type UsageGroup, type UsageGrouping, type UsageMetric, type UsagePeriod, type UsageReport,
} from '../usageOverview'

const PERIOD_KEY = 'foxwarm.systemUsage.period'
const SERIES_COLORS = ['accent', 'special', 'success', 'warning', 'info', 'tool', 'syntax-keyword', 'danger'].map(name => `var(--foxwarm-color-${name})`)
const OTHER_COLOR = 'var(--foxwarm-color-text-subtle)'

// Requests from elsewhere (the status bar) apply once, not again when the section remounts.
let appliedRequest = 0

const storedPeriod = (): UsagePeriod => {
  try {
    const value = window.localStorage.getItem(PERIOD_KEY)
    return USAGE_PERIODS.some(item => item.id === value) ? value as UsagePeriod : 'month'
  } catch { return 'month' }
}

const formatDay = (time: number) => new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const seriesColor = (id: string, index: number) => id === 'other' ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length]

function UsageChart({ report, unit, metric }: { report: UsageReport; unit: 'hour' | 'day'; metric: UsageMetric }) {
  const series = useMemo(() => usageSeries(report, metric), [report, metric])
  const totals = report.buckets.map((_, index) => series.reduce((sum, item) => sum + item.values[index], 0))
  const max = Math.max(0, ...totals)
  const format = (value: number) => metric === 'cost' ? formatUsdCost(value) : `${formatUsageNumber(value)} tokens`
  const labelEvery = Math.max(1, Math.ceil(report.buckets.length / 12))
  return (
    <div data-usage-chart>
      <div className="flex h-40 items-end gap-px border-b border-fw-border-muted" role="img" aria-label={`${metric === 'cost' ? 'Estimated cost' : 'Tokens'} per ${unit}`}>
        {report.buckets.map((_, index) => (
          <div key={index} title={`${usageBucketLabel(report.boundaries[index], unit)} · ${format(totals[index])}`} className="flex h-full min-w-0 flex-1 flex-col-reverse hover:bg-fw-hover" data-usage-bucket={index}>
            {max > 0 ? series.map((item, seriesIndex) => item.values[index] > 0 ? (
              <span key={item.id} className="block w-full" style={{ height: `${item.values[index] / max * 100}%`, minHeight: 1, background: seriesColor(item.id, seriesIndex) }} />
            ) : null) : null}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px text-[10px] text-fw-text-muted">
        {report.buckets.map((_, index) => (
          <span key={index} className="min-w-0 flex-1 whitespace-nowrap">{index % labelEvery === 0 ? usageBucketLabel(report.boundaries[index], unit) : ''}</span>
        ))}
      </div>
      {series[0]?.id !== 'total' ? (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fw-text-muted">
          {series.map((item, index) => (
            <span key={item.id} className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ background: seriesColor(item.id, index) }} />
              <span className="truncate">{item.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CostValue({ usage }: { usage: UsageGroup['usage'] }) {
  if (usage.cost === undefined) return <span className="text-fw-text-muted">Tokens only</span>
  return <span title={usage.unpricedRequests ? `${usage.unpricedRequests} of ${usage.requests} requests had no price` : undefined}>
    {formatUsdCost(usage.cost)}{usage.unpricedRequests ? <span className="text-fw-warning"> *</span> : null}
  </span>
}

export interface SystemUsageProps {
  /** Selects a period when opened from elsewhere; a new nonce repeats the request. */
  request?: { period: UsagePeriod; nonce: number } | null
  onOpenSession: (sessionId: string) => void
}

export default function SystemUsage({ request, onOpenSession }: SystemUsageProps) {
  const [period, setPeriodState] = useState<UsagePeriod>(storedPeriod)
  const [grouping, setGrouping] = useState<UsageGrouping>('agent')
  const [agent, setAgent] = useState<string | null>(null)
  const [metricChoice, setMetricChoice] = useState<UsageMetric>('cost')
  const day = useLocalDay()
  const [custom, setCustom] = useState(() => {
    const now = new Date()
    return { from: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)), to: toDateInput(now) }
  })
  const setPeriod = (next: UsagePeriod) => {
    setPeriodState(next)
    try { window.localStorage.setItem(PERIOD_KEY, next) } catch {}
  }
  useEffect(() => {
    if (!request || request.nonce <= appliedRequest) return
    appliedRequest = request.nonce
    setPeriod(request.period)
  }, [request?.nonce])

  const range = useMemo(() => usageRange(period, new Date(), custom), [period, custom.from, custom.to, day])
  const url = range ? usageQuery(range, { groupBy: grouping, agent, limit: 100 }) : null
  const { report, error, loading, reload } = useUsageReport(url)
  const current = report && range && report.groupBy === grouping && (report.agent ?? null) === agent && report.boundaries.join() === range.boundaries.join() ? report : null
  // The previous report stays visible, dimmed, until the new selection's report arrives.
  const shownRef = useRef<{ report: UsageReport; unit: 'hour' | 'day' } | null>(null)
  if (current && range) shownRef.current = { report: current, unit: range.unit }
  const shown = shownRef.current
  const stale = !current
  const priced = shown?.report.total.cost !== undefined
  const metric: UsageMetric = priced ? metricChoice : 'tokens'
  const shares = shown?.report.groups?.map(group => usageMetricValue(group.usage, metric)) || []
  const shareMax = Math.max(0, ...shares)
  const groupingLabel = USAGE_GROUPINGS.find(item => item.id === (shown?.report.groupBy || grouping))!.label

  const segment = (active: boolean) => `rounded-md px-3 py-1 text-xs font-medium ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`
  const select = 'h-9 min-w-0 rounded-lg border border-transparent bg-transparent px-3 text-xs font-medium text-fw-text outline-none hover:bg-fw-hover focus:border-fw-accent-border'
  const dateInput = 'h-9 rounded-lg border border-fw-border bg-fw-surface px-2 text-xs text-fw-text-strong outline-none focus:border-fw-accent-border'
  const card = 'rounded-xl border border-fw-border bg-fw-surface p-4'
  const coverage = current?.coverage
  const begins = coverage && range ? usageRecordsBegin(range, coverage.earliest) : null
  const coverageNote = !coverage ? '' : !coverage.complete ? 'Adding earlier usage…' : begins !== null ? `Usage records begin ${formatDay(begins)}` : ''
  const unpriced = shown?.report.total.unpricedRequests || 0

  return (
    <div className="space-y-4" data-system-usage data-usage-period={period} data-usage-grouping={grouping}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5" role="group" aria-label="Usage period">
            {USAGE_PERIODS.map(item => (
              <button key={item.id} type="button" aria-pressed={period === item.id} data-usage-period-option={item.id} onClick={() => setPeriod(item.id)} className={segment(period === item.id)}>{item.label}</button>
            ))}
          </div>
          {period === 'custom' ? (
            <div className="flex items-center gap-1 text-xs text-fw-text-muted">
              <input type="date" aria-label="Usage from" value={custom.from} max={custom.to} onChange={event => setCustom(value => ({ ...value, from: event.target.value }))} className={dateInput} />
              <span>–</span>
              <input type="date" aria-label="Usage to" value={custom.to} min={custom.from} onChange={event => setCustom(value => ({ ...value, to: event.target.value }))} className={dateInput} />
            </div>
          ) : null}
          <label className="flex items-center gap-1 text-xs text-fw-text-muted">
            <span>Group by</span>
            <select aria-label="Group usage by" value={grouping} onChange={event => setGrouping(event.target.value as UsageGrouping)} className={select}>
              {USAGE_GROUPINGS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {agent ? (
            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-fw-accent-surface px-2.5 py-1 text-xs text-fw-accent" data-usage-agent-filter={agent}>
              <ListFilter className="h-3 w-3" /><span className="truncate">Agent {agent}</span>
              <button type="button" aria-label="Show usage for all agents" onClick={() => setAgent(null)} className="rounded-full p-0.5 hover:bg-fw-hover"><X className="h-3 w-3" /></button>
            </span>
          ) : null}
        </div>
        {coverageNote ? <span className="text-xs text-fw-text-muted" data-usage-coverage>{coverageNote}</span> : null}
      </div>
      {!range ? <div className="rounded-xl border border-fw-warning-border bg-fw-warning-surface px-3 py-2 text-xs text-fw-warning">Choose a range of up to {MAX_USAGE_DAYS} days.</div> : null}
      {error ? <div className="flex items-center justify-between gap-3 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger"><span>{error}</span><button type="button" onClick={() => { void reload() }} className="font-medium underline">Retry</button></div> : null}

      {shown ? <div className={`space-y-4 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale} data-usage-stale={stale || undefined}>
        <div className="grid gap-3 md:grid-cols-3">
          <section className={card} data-usage-summary="cost">
            <div className="text-[10px] text-fw-text-muted">Estimated cost</div>
            <strong className="mt-1 block text-2xl font-semibold tabular-nums text-fw-text-strong" data-usage-total-cost>{shown.report.total.cost !== undefined ? formatUsdCost(shown.report.total.cost) : '—'}</strong>
            <p className="mt-1 text-xs text-fw-text-muted" data-usage-unpriced={unpriced}>
              {unpriced > 0
                ? `${unpriced.toLocaleString('en')} ${unpriced === 1 ? 'request has' : 'requests have'} no price and ${unpriced === 1 ? 'counts' : 'count'} tokens only.`
                : shown.report.total.requests > 0 ? 'Every request has a recorded price.' : 'No model requests in this period.'}
            </p>
          </section>
          <section className={card} data-usage-summary="tokens">
            <TokenUsageDetails usage={{ cachedTokens: shown.report.total.cachedTokens, inputTokens: shown.report.total.inputTokens, outputTokens: shown.report.total.outputTokens }} detailed />
          </section>
          <section className={card} data-usage-summary="requests">
            <div className="text-[10px] text-fw-text-muted">Model requests</div>
            <strong className="mt-1 block text-2xl font-semibold tabular-nums text-fw-text-strong" data-usage-total-requests>{shown.report.total.requests.toLocaleString('en')}</strong>
            <p className="mt-1 text-xs text-fw-text-muted">Every model request, including compaction, titles and other background work.</p>
          </section>
        </div>

        <section className={card}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fw-text-strong">{metric === 'cost' ? 'Estimated cost' : 'Tokens'} by {groupingLabel.toLowerCase()}</h2>
            {priced ? (
              <div className="inline-flex rounded-lg border border-fw-border bg-fw-section p-0.5" role="group" aria-label="Chart measure">
                <button type="button" aria-pressed={metric === 'cost'} onClick={() => setMetricChoice('cost')} className={segment(metric === 'cost')}>Cost</button>
                <button type="button" aria-pressed={metric === 'tokens'} onClick={() => setMetricChoice('tokens')} className={segment(metric === 'tokens')}>Tokens</button>
              </div>
            ) : null}
          </div>
          <UsageChart report={shown.report} unit={shown.unit} metric={metric} />
        </section>

        <section className="overflow-hidden rounded-xl border border-fw-border bg-fw-surface" data-usage-groups>
          <table className="w-full table-fixed text-xs">
            <thead className="border-b border-fw-border-muted text-left text-[10px] text-fw-text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{groupingLabel}</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Requests</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Tokens</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Estimated cost</th>
                <th className="hidden w-40 px-4 py-2 font-medium md:table-cell"><span className="sr-only">Share</span></th>
              </tr>
            </thead>
            <tbody>
              {(shown.report.groups || []).map((group, index) => {
                const label = usageGroupLabel(group)
                const detail = usageGroupDetail(group)
                const openable = (group.kind === 'session' || group.kind === 'tree') && group.key
                const drill = group.kind === 'agent' && group.key
                return (
                  <tr key={`${group.kind}:${group.key ?? ''}`} className="border-b border-fw-border-muted last:border-0" data-usage-row={group.key ?? ''} data-usage-row-kind={group.kind}>
                    <td className="px-4 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {drill ? (
                          <button type="button" onClick={() => { setAgent(group.key); setGrouping('tree') }} title={`Show session trees in ${group.key}`} className="min-w-0 truncate text-left font-medium text-fw-accent hover:underline">{label}</button>
                        ) : <span className="min-w-0 truncate font-medium text-fw-text-strong" title={group.key ?? undefined}>{label}</span>}
                        {openable ? <button type="button" aria-label={`Open ${label}`} title="Open session" onClick={() => onOpenSession(group.key!)} className="shrink-0 rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-accent"><ExternalLink className="h-3 w-3" /></button> : null}
                      </div>
                      {detail ? <div className="truncate text-[11px] text-fw-text-muted" title={detail}>{detail}</div> : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-fw-text">{group.usage.requests.toLocaleString('en')}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-fw-text" title={`${usageTokens(group.usage).toLocaleString('en')} tokens`}>{formatUsageNumber(usageTokens(group.usage))}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-fw-text-strong"><CostValue usage={group.usage} /></td>
                    <td className="hidden px-4 py-2 md:table-cell">
                      <div className="h-1.5 overflow-hidden rounded-full bg-fw-border-muted">
                        <div className="h-full rounded-full" style={{ width: `${shareMax > 0 ? shares[index] / shareMax * 100 : 0}%`, background: group.buckets ? seriesColor('', index) : OTHER_COLOR }} />
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!shown.report.groups?.length ? <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-fw-text-muted">No model requests in this period.</td></tr> : null}
            </tbody>
          </table>
          {shown.report.groupCount !== undefined && shown.report.groups && shown.report.groupCount > shown.report.groups.length ? (
            <div className="border-t border-fw-border-muted px-4 py-2 text-xs text-fw-text-muted">Showing the top {shown.report.groups.length} of {shown.report.groupCount}.</div>
          ) : null}
          {unpriced > 0 && shown.report.groups?.some(group => group.usage.cost !== undefined && group.usage.unpricedRequests) ? (
            <div className="border-t border-fw-border-muted px-4 py-2 text-xs text-fw-text-muted"><span className="text-fw-warning">*</span> Includes requests without a price.</div>
          ) : null}
        </section>
      </div> : !error && range ? <div className="p-6 text-sm text-fw-text-muted">{loading ? 'Loading usage…' : ''}</div> : null}
    </div>
  )
}

import { API_BASE_PATH } from './config'

/** Installation usage from GET /api/usage: recorded estimates only, never repriced. */
export type UsageTotals = {
  requests: number
  cachedTokens: number
  inputTokens: number
  outputTokens: number
  /** Requests whose model had no price when they ran; their tokens still count. */
  unpricedRequests: number
  /** Present only when at least one included request was priced. */
  cost?: number
}

export type UsageGrouping = 'agent' | 'tree' | 'session' | 'model' | 'provider' | 'purpose'
export type UsageGroupKind = 'agent' | 'unknown' | 'none' | 'tree' | 'session' | 'deleted' | 'model' | 'provider' | 'purpose'

export type UsageGroup = {
  key: string | null
  kind: UsageGroupKind
  label?: string
  agent?: string
  usage: UsageTotals
  /** Per-bucket totals, sent for the largest groups only. */
  buckets?: UsageTotals[]
}

export type UsageReport = {
  boundaries: number[]
  groupBy: UsageGrouping | null
  agent: string | null
  total: UsageTotals
  buckets: UsageTotals[]
  groups?: UsageGroup[]
  groupCount?: number
  coverage: { earliest: number | null; complete: boolean }
}

export type UsagePeriod = 'today' | 'week' | 'month' | 'custom'
export type UsageRange = { boundaries: number[]; unit: 'hour' | 'day' }

export const USAGE_PERIODS: Array<{ id: UsagePeriod; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
]

export const USAGE_GROUPINGS: Array<{ id: UsageGrouping; label: string }> = [
  { id: 'agent', label: 'Agent' },
  { id: 'tree', label: 'Session tree' },
  { id: 'session', label: 'Session' },
  { id: 'model', label: 'Model' },
  { id: 'provider', label: 'Provider' },
  { id: 'purpose', label: 'Purpose' },
]

export const USAGE_PURPOSE_LABELS: Record<string, string> = {
  'normal-turn': 'Conversation turns',
  normal: 'Older conversation turns',
  'compact-plan': 'Context compaction',
  btw: 'Side questions',
  'toolscript-one-shot': 'ToolScript model calls',
  background: 'Session titles',
  'setup-test': 'Setup checks',
  cli: 'Command line',
  'low-level': 'Other requests',
}

/** Matches the server's bucket limit. */
export const MAX_USAGE_DAYS = 400

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

/** Strictly increasing local-time boundaries; DST repeats or gaps collapse to one boundary. */
function increasing(dates: Date[]): number[] {
  const result: number[] = []
  for (const date of dates) {
    const time = date.getTime()
    if (!result.length || time > result[result.length - 1]) result.push(time)
  }
  return result
}

function days(start: Date, count: number): number[] {
  return increasing(Array.from({ length: count + 1 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)))
}

export const parseDateInput = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getDate() === Number(match[3]) ? date : null
}

export const toDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * Local-time buckets for a period: hours for today, days otherwise. Weeks start on Monday.
 * Custom ranges include both dates and return null when invalid or longer than the limit.
 */
export function usageRange(period: UsagePeriod, now: Date = new Date(), custom?: { from: string; to: string }): UsageRange | null {
  const today = startOfDay(now)
  if (period === 'today') {
    return { unit: 'hour', boundaries: increasing(Array.from({ length: 25 }, (_, hour) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour))) }
  }
  if (period === 'week') {
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7))
    return { unit: 'day', boundaries: days(monday, 7) }
  }
  if (period === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1)
    return { unit: 'day', boundaries: days(first, new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()) }
  }
  const from = custom ? parseDateInput(custom.from) : null
  const to = custom ? parseDateInput(custom.to) : null
  if (!from || !to || to < from) return null
  const count = Math.round((startOfDay(to).getTime() - from.getTime()) / 86_400_000) + 1
  if (count > MAX_USAGE_DAYS) return null
  return { unit: 'day', boundaries: days(from, count) }
}

/**
 * Notes when recorded usage starts after the period's first day, so empty earlier days are not
 * read as idle. Records that begin within the first day need no note.
 */
export function usageRecordsBegin(range: UsageRange, earliest: number | null): number | null {
  if (earliest === null) return null
  return startOfDay(new Date(earliest)).getTime() > range.boundaries[0] ? earliest : null
}

/** Milliseconds until the next local midnight, when today's and this period's buckets move. */
export const msUntilNextDay = (now: Date = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()

export function usageQuery(range: UsageRange, options: { groupBy?: UsageGrouping | null; agent?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams({ boundaries: range.boundaries.join(',') })
  if (options.groupBy) params.set('groupBy', options.groupBy)
  if (options.agent) params.set('agent', options.agent)
  if (options.limit) params.set('limit', String(options.limit))
  return `${API_BASE_PATH}/usage?${params}`
}

export async function loadUsage(url: string, signal?: AbortSignal): Promise<UsageReport> {
  const response = await fetch(url, { signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Usage request failed (${response.status})`)
  return payload as UsageReport
}

export const usageTokens = (usage: UsageTotals) => usage.cachedTokens + usage.inputTokens + usage.outputTokens

export function usageGroupLabel(group: UsageGroup): string {
  switch (group.kind) {
    case 'none': return 'Outside sessions'
    case 'unknown': return 'Unattributed sessions'
    case 'deleted': return 'Deleted sessions'
    case 'purpose': return USAGE_PURPOSE_LABELS[group.key || ''] || group.key || 'Unknown'
    case 'tree':
    case 'session': return group.label?.trim() || group.key || 'Unknown'
    default: return group.key || 'Unknown'
  }
}

/** Secondary text: the technical key behind a friendly label, or the owning Agent. */
export function usageGroupDetail(group: UsageGroup): string | undefined {
  if (group.kind === 'tree' || group.kind === 'session') return group.label?.trim() ? group.key || undefined : group.agent
  if (group.kind === 'deleted') return group.agent || undefined
  if (group.kind === 'purpose' && USAGE_PURPOSE_LABELS[group.key || '']) return group.key || undefined
  return undefined
}

export type UsageMetric = 'cost' | 'tokens'
export const usageMetricValue = (usage: UsageTotals, metric: UsageMetric) => metric === 'cost' ? usage.cost ?? 0 : usageTokens(usage)

export type UsageSeries = { id: string; label: string; values: number[] }

/** Chart series: the groups that carry buckets, plus the remainder of each bucket as Other. */
export function usageSeries(report: UsageReport, metric: UsageMetric): UsageSeries[] {
  const totals = report.buckets.map(bucket => usageMetricValue(bucket, metric))
  if (!report.groups?.length) return [{ id: 'total', label: 'Total', values: totals }]
  // Groups with nothing to draw for this measure (an unpriced group on the cost chart) stay out of the legend.
  const series = report.groups.filter(group => group.buckets).map(group => ({
    id: `${group.kind}:${group.key ?? ''}`,
    label: usageGroupLabel(group),
    values: group.buckets!.map(bucket => usageMetricValue(bucket, metric)),
  })).filter(item => item.values.some(value => value > 0))
  const other = totals.map((total, index) => Math.max(0, total - series.reduce((sum, item) => sum + item.values[index], 0)))
  // Floating-point remainders of summed costs are not a real Other share.
  const threshold = metric === 'cost' ? 1e-9 : 0
  if (other.some(value => value > threshold)) series.push({ id: 'other', label: 'Other', values: other.map(value => value > threshold ? value : 0) })
  return series
}

export function usageBucketLabel(start: number, unit: UsageRange['unit']): string {
  const date = new Date(start)
  return unit === 'hour'
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

import { ShieldCheck } from 'lucide-react'
import { formatUsageNumber } from './TokenUsageDetails'
import { usageGroupLabel, type UsageGroup, type UsageReport } from '../usageOverview'
import {
  formatDetectionTime, formatRedactionFailure, formatRedactionLabel, redactionFailureCount, type UsageRedaction,
} from '../textRedaction'

const entries = (values: Record<string, number>) => Object.entries(values).filter(([, value]) => value > 0).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))

function Counts({ values, format, tone = 'normal', label }: { values: Record<string, number>; format: (key: string) => string; tone?: 'normal' | 'warning'; label: string }) {
  const items = entries(values)
  if (!items.length) return null
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map(([key, value]) => (
        <li key={key} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${tone === 'warning' ? 'bg-fw-warning-surface text-fw-warning' : 'bg-fw-section text-fw-text'}`} data-redaction-count={key}>
          <span>{format(key)}</span>
          <span className="font-medium tabular-nums">{value.toLocaleString('en')}</span>
        </li>
      ))}
    </ul>
  )
}

const averageDetection = (redaction: UsageRedaction) => redaction.attempts ? redaction.detectionMs / redaction.attempts : 0
const cacheShare = (redaction: UsageRedaction) => redaction.slots ? `${Math.round(redaction.cachedSlots / redaction.slots * 100)}%` : '—'

function Stat({ label, value, detail, data }: { label: string; value: string; detail?: string; data: string }) {
  return (
    <div className="min-w-0" data-redaction-stat={data}>
      <div className="text-[10px] text-fw-text-muted">{label}</div>
      <strong className="mt-1 block text-lg font-semibold tabular-nums leading-none text-fw-text-strong">{value}</strong>
      {detail ? <div className="mt-1 truncate text-[11px] text-fw-text-muted">{detail}</div> : null}
    </div>
  )
}

/** System › Usage: what text redaction replaced and how detection performed, by the current grouping. */
export default function SystemUsageRedaction({ report, groupingLabel }: { report: UsageReport; groupingLabel: string }) {
  const redaction = report.total.redaction
  if (!redaction) return null
  const failures = redactionFailureCount(redaction)
  const groups = (report.groups || []).filter((group): group is UsageGroup & { usage: { redaction: UsageRedaction } } => !!group.usage.redaction)
  return (
    <section className="rounded-xl border border-fw-border bg-fw-surface" data-usage-redaction>
      <div className="space-y-4 p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fw-text-strong"><ShieldCheck className="h-3.5 w-3.5 text-fw-text-muted" aria-hidden="true" />Text redaction</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat data="requests" label="Redacted requests" value={redaction.attempts.toLocaleString('en')} />
          <Stat data="replacements" label="Replacements" value={redaction.replacements.toLocaleString('en')}
            detail={redaction.literal ? `${redaction.literal.toLocaleString('en')} matched ${redaction.literal === 1 ? 'an earlier find' : 'earlier finds'}` : undefined} />
          <Stat data="detection" label="Detection time" value={redaction.attempts ? formatDetectionTime(averageDetection(redaction)) : '—'}
            detail={redaction.attempts ? `Per request · ${cacheShare(redaction)} cached` : undefined} />
          <Stat data="failures" label="Detection failures" value={failures.toLocaleString('en')}
            detail={failures ? 'Not sent to the model' : undefined} />
        </div>
        <Counts label="Replacements by type" values={redaction.labels} format={formatRedactionLabel} />
        <Counts label="Detection failures by reason" values={redaction.failures} format={formatRedactionFailure} tone="warning" />
      </div>
      {groups.length ? (
        <table className="w-full table-fixed border-t border-fw-border-muted text-xs" data-usage-redaction-groups>
          <thead className="border-b border-fw-border-muted text-left text-[10px] text-fw-text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">{groupingLabel}</th>
              <th className="w-24 px-2 py-2 text-right font-medium">Requests</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Replacements</th>
              <th className="hidden w-28 px-2 py-2 text-right font-medium sm:table-cell">Detection</th>
              <th className="w-24 px-4 py-2 text-right font-medium">Failures</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(group => {
              const item = group.usage.redaction
              const groupFailures = redactionFailureCount(item)
              const failureTitle = entries(item.failures).map(([kind, value]) => `${formatRedactionFailure(kind)} ${value}`).join(', ')
              const labelTitle = entries(item.labels).map(([label, value]) => `${formatRedactionLabel(label)} ${value}`).join(', ')
              return (
                <tr key={`${group.kind}:${group.key ?? ''}`} className="border-b border-fw-border-muted last:border-0" data-usage-redaction-row={group.key ?? ''}>
                  <td className="truncate px-4 py-2 font-medium text-fw-text-strong" title={group.key ?? undefined}>{usageGroupLabel(group)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fw-text">{item.attempts.toLocaleString('en')}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fw-text" title={labelTitle || undefined}>{formatUsageNumber(item.replacements)}</td>
                  <td className="hidden px-2 py-2 text-right tabular-nums text-fw-text sm:table-cell" title="Per request">{item.attempts ? formatDetectionTime(averageDetection(item)) : '—'}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${groupFailures ? 'text-fw-warning' : 'text-fw-text-muted'}`} title={failureTitle || undefined}>{groupFailures.toLocaleString('en')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

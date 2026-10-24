import { formatUsdCost } from '../usageCost'
import { ArrowDownLeft, ArrowUpRight, Database, Layers3 } from 'lucide-react'

export type TokenUsage = { cachedTokens: number; inputTokens: number; outputTokens: number; cost?: number }

export const formatUsageNumber = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

export default function TokenUsageDetails({ usage, loaded = false, detailed = false }: {
  usage?: TokenUsage
  loaded?: boolean
  detailed?: boolean
}) {
  const total = usage ? usage.cachedTokens + usage.inputTokens + usage.outputTokens : 0
  const parts = [
    { label: 'Cached', value: usage?.cachedTokens || 0, color: 'bg-fw-text-subtle', ink: 'text-fw-text-muted', icon: Database },
    { label: 'Input', value: usage?.inputTokens || 0, color: 'bg-fw-accent', ink: 'text-fw-accent', icon: ArrowDownLeft },
    { label: 'Output', value: usage?.outputTokens || 0, color: 'bg-fw-special', ink: 'text-fw-special', icon: ArrowUpRight },
  ]
  const label = loaded ? 'Loaded tokens' : 'Tokens'
  const description = usage ? `${label}: ${total.toLocaleString('en')}. ${parts.map(part => `${part.label}: ${part.value.toLocaleString('en')}`).join(', ')}` : `${label}: unavailable`
  return (
    <div className="min-w-0" title={description}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[10px] text-fw-text-muted"><Layers3 className="h-3 w-3" aria-hidden="true" />{label}</span>
        <strong className={`${detailed ? 'text-lg' : 'text-sm'} font-semibold tabular-nums leading-none text-fw-text-strong`}>{usage ? formatUsageNumber(total) : '—'}</strong>
      </div>
      <div role="img" aria-label={description} className="mt-2 flex h-1 overflow-hidden rounded-full bg-fw-border-muted">
        {total > 0 ? parts.filter(part => part.value > 0).map(part => <span key={part.label} className={part.color} style={{ width: `${part.value / total * 100}%` }} />) : null}
      </div>
      {usage?.cost !== undefined ? <div className="mt-2 flex items-baseline justify-between gap-3 text-xs">
        <span className="text-fw-text-muted">{loaded ? 'Loaded recorded estimate' : 'Recorded estimated cost'}</span>
        <span className="font-medium tabular-nums text-fw-text-strong">{formatUsdCost(usage.cost)}</span>
      </div> : null}
      {detailed && usage ? <div className="mt-3 space-y-2">
        {parts.map(part => <div key={part.label} className="flex min-w-0 items-center gap-2 text-xs tabular-nums">
          <part.icon className={`h-3 w-3 shrink-0 ${part.ink}`} aria-hidden="true" />
          <span className="text-fw-text-muted">{part.label}</span>
          <span className="ml-auto shrink-0 font-medium text-fw-text-strong">{formatUsageNumber(part.value)}</span>
          <span className="w-14 shrink-0 text-right text-fw-text-muted">{total > 0 ? (part.value / total * 100).toFixed(1) : '0.0'}%</span>
        </div>)}
      </div> : null}
    </div>
  )
}

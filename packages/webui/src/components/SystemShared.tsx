import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { Session } from './SessionListCore'
import UsageDetails, { formatUsageNumber as usageNumber, type TokenUsage } from './TokenUsageDetails'
import { getSessionRuntimeTone } from '../sessionRuntimeState'

export const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return 'No messages yet'
  const diff = Math.max(0, Date.now() - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  return `${Math.floor(diff / day)}d ago`
}

export const formatBusyDuration = (startedAt?: number | null, now: number = Date.now()) => {
  if (!startedAt) return '—'
  const totalSeconds = Math.floor(Math.max(0, now - startedAt) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export const formatTokenCount = (value: number | undefined) => {
  const tokens = value || 0
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return String(tokens)
}

export const renderMetaBadge = (label: string, tone: 'default' | 'active' | 'warning' | 'muted' = 'default') => {
  const toneClasses = {
    default: 'bg-fw-neutral-surface text-fw-text dark:bg-fw-surface-raised/70 dark:text-fw-text-strong',
    active: 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent',
    warning: 'bg-fw-warning-surface text-fw-warning dark:bg-fw-warning-surface-strong/40 dark:text-fw-warning',
    muted: 'bg-fw-surface-sunken text-fw-text-muted dark:bg-fw-surface dark:text-fw-text-muted',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClasses[tone]}`}>{label}</span>
}

export const getStatusTone = (session: Session) => {
  const tone = getSessionRuntimeTone(session)
  return tone === 'muted' ? 'bg-fw-border-strong dark:bg-fw-text' : `bg-fw-${tone}`
}

export type LoadedUsage = TokenUsage & { count: number }

export function addLoadedUsage(total: LoadedUsage, session: Session) {
  if (!session.tokenUsage) return total
  total.cachedTokens += session.tokenUsage.cachedTokens || 0
  total.inputTokens += session.tokenUsage.inputTokens || 0
  total.outputTokens += session.tokenUsage.outputTokens || 0
  if (session.tokenUsage.cost !== undefined) total.cost = (total.cost ?? 0) + session.tokenUsage.cost
  total.count += 1
  return total
}

export const emptyLoadedUsage = (): LoadedUsage => ({ cachedTokens: 0, inputTokens: 0, outputTokens: 0, count: 0 })

export function UsagePie({ usage, loaded = false, global = false }: { usage?: TokenUsage; loaded?: boolean; global?: boolean }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const total = usage ? usage.cachedTokens + usage.inputTokens + usage.outputTokens : 0
  const cached = total ? usage!.cachedTokens / total * 100 : 0
  const inputEnd = cached + (total ? usage!.inputTokens / total * 100 : 0)
  useEffect(() => {
    if (!position) return
    const dismiss = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPosition(null); trigger.current?.focus() } }
    const close = () => setPosition(null)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true) }
  }, [position])
  return <>
    <button ref={trigger} type="button" aria-label={global ? 'Global token usage' : loaded ? 'Loaded token usage' : 'Token usage'} aria-haspopup="dialog" aria-expanded={!!position}
      title={usage ? `${usageNumber(total)} ${loaded ? 'loaded tokens' : 'tokens'}` : 'Token usage unavailable'}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setPosition(position ? null : { left: Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288)), top: rect.bottom + 210 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 210) }) }}
      className={`flex shrink-0 items-center rounded-lg transition-colors hover:bg-fw-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring ${global ? 'gap-3 px-3 py-1.5 text-left' : 'h-8 w-8 justify-center'}`}>
      <span aria-hidden="true" className={`${global ? 'h-8 w-8' : 'h-5 w-5'} shrink-0 rounded-full ring-1 ring-inset ring-fw-border/30`} style={{ background: total ? `conic-gradient(var(--foxwarm-color-text-subtle) 0% ${cached}%, var(--foxwarm-color-accent) ${cached}% ${inputEnd}%, var(--foxwarm-color-special) ${inputEnd}% 100%)` : 'var(--foxwarm-color-border)' }} />
      {global ? <>
        <span className="flex flex-col gap-0.5"><span className="text-[10px] font-medium tracking-wide text-fw-text-muted">Usage</span><strong className="text-lg font-semibold leading-none tabular-nums text-fw-text-strong">{usage ? usageNumber(total) : '—'}</strong></span>
        <ChevronRight aria-hidden="true" className={`ml-1 h-3.5 w-3.5 text-fw-text-muted transition-transform ${position ? '-rotate-90' : 'rotate-90'}`} />
      </> : null}
    </button>
    {position ? createPortal(<div ref={popup} role="dialog" aria-label="Token usage" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      className="fixed z-[1000] w-[280px] max-w-[calc(100vw-16px)] rounded-xl border border-fw-border bg-fw-surface p-4 shadow-xl" style={position}>
      <UsageDetails usage={usage} loaded={loaded} detailed />
    </div>, document.body) : null}
  </>
}

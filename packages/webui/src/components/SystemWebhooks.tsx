import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronRight, Code2, Copy, ExternalLink, MessageSquare, Webhook } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { webUiRealtime } from '../realtime'
import { formatTimerTime } from '../systemTimers'
import {
  WEBHOOK_OUTCOME_LABELS, isLocalWebhookUrl, orderWebhooks, webhookActionLabel, webhookDeliveryTitle, webhookNeedsAttention,
  webhookOutcomeTone, webhookVerifyLabel, type WebhookDelivery, type WebhookRow, type WebhookTone,
} from '../systemWebhooks'
import JsonInspectorDialog from './JsonInspectorDialog'
import { copyTextToClipboard } from './chatShared'

async function webhookRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Webhook request failed (${response.status})`)
  return payload as T
}

/** Reloads on deliveries, handler progress and configuration saves while mounted. */
function useWebhookList() {
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const current = ++generation.current
    try {
      const payload = await webhookRequest<{ webhooks: WebhookRow[] }>('/webhooks')
      if (current !== generation.current) return
      setWebhooks(payload.webhooks || []); setError('')
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoaded(true)
    }
  }, [])
  useEffect(() => {
    void reload()
    let pending: number | null = null
    const schedule = () => { if (pending === null) pending = window.setTimeout(() => { pending = null; void reload() }, 250) }
    const unsubscribe = webUiRealtime.subscribeSessionList([], {
      onOpen: schedule,
      onMessage: message => { if (message.type === 'webhooks-changed') schedule() },
    })
    return () => { if (pending !== null) window.clearTimeout(pending); unsubscribe(); generation.current++ }
  }, [reload])
  return { webhooks, loaded, error, reload }
}

function useMinuteClock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  return now
}

// Deliveries are always in the past; the minute clock can lag a fresh one.
const formatPast = (at: number, now: number) => formatTimerTime(at, Math.max(now, at + 1))

const toneClasses: Record<WebhookTone, string> = {
  success: 'bg-fw-success-surface text-fw-success',
  danger: 'bg-fw-danger-surface text-fw-danger',
  warning: 'bg-fw-warning-surface text-fw-warning',
  muted: 'bg-fw-surface-sunken text-fw-text-muted',
  active: 'bg-fw-accent-surface text-fw-accent',
}
const Badge = ({ tone, children, title }: { tone: WebhookTone; children: ReactNode; title?: string }) =>
  <span title={title} className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClasses[tone]}`}>{children}</span>

const OutcomeBadge = ({ delivery }: { delivery?: WebhookDelivery }) => delivery
  ? <Badge tone={webhookOutcomeTone(delivery.outcome)} title={delivery.error}>{WEBHOOK_OUTCOME_LABELS[delivery.outcome] || delivery.outcome}</Badge>
  : <Badge tone="muted">No deliveries yet</Badge>

const ActionIcon = ({ webhook }: { webhook: WebhookRow }) => webhook.action === 'toolscript'
  ? <Code2 aria-label="ToolScript" className="h-4 w-4 shrink-0 text-fw-special" />
  : <MessageSquare aria-label="Message" className="h-4 w-4 shrink-0 text-fw-accent" />

const Field = ({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-1 text-xs">
    <dt className="text-fw-text-muted">{label}</dt>
    <dd className={`min-w-0 break-words text-fw-text-strong ${mono ? 'font-mono' : ''}`}>{children}</dd>
  </div>
)

const sectionClass = 'mt-4 border-t border-fw-border-muted pt-4'
const headingClass = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-fw-text-muted'

function WebhookRowCard({ webhook, selected, now, onSelect }: { webhook: WebhookRow; selected: boolean; now: number; onSelect: () => void }) {
  const last = webhook.deliveries[0]
  return (
    <button type="button" onClick={onSelect} data-system-webhook-id={webhook.id} data-system-webhook-selected={selected || undefined}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${selected ? 'border-fw-accent-border bg-fw-accent-section' : 'border-fw-border bg-fw-surface hover:bg-fw-hover'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <ActionIcon webhook={webhook} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fw-text-strong">{webhook.id}</span>
        {webhook.targetSessionId ? <OutcomeBadge delivery={last} /> : <Badge tone="danger">Session unavailable</Badge>}
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-fw-text-muted">
        <span className="min-w-0 truncate">{webhookVerifyLabel(webhook)}</span>
        <span className="min-w-0 truncate">→ {webhook.targetSessionId || webhook.session}</span>
        {last ? <span className="min-w-0 truncate">{formatPast(last.at, now)}</span> : null}
      </div>
    </button>
  )
}

function CopyAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [url])
  return (
    <span className="flex min-w-0 items-start gap-1">
      <span className="min-w-0 break-all font-mono" data-system-webhook-url>{url}</span>
      <button type="button" aria-label="Copy address" title="Copy address" onClick={() => { void copyTextToClipboard(url).then(() => setCopied(true)) }}
        className="shrink-0 rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text">
        {copied ? <Check className="h-3 w-3 text-fw-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  )
}

function WebhookInspector({ webhook, now, onInspectSession, onOpenSession }: {
  webhook: WebhookRow | null
  now: number
  onInspectSession: (sessionId: string) => void
  onOpenSession: (sessionId: string) => void
}) {
  const [run, setRun] = useState<{ runId: string; text: string; loading: boolean } | null>(null)
  if (!webhook) {
    return (
      <aside className="rounded-xl border border-dashed border-fw-border-strong bg-fw-surface/60 p-6 text-center">
        <Webhook className="mx-auto h-6 w-6 text-fw-text" />
        <h3 className="mt-3 text-sm font-semibold text-fw-text-strong">Select a webhook</h3>
        <p className="mt-1 text-xs leading-5 text-fw-text-muted">See its address, where deliveries go and what arrived recently.</p>
      </aside>
    )
  }
  const openRun = async (runId: string) => {
    setRun({ runId, text: '', loading: true })
    try {
      const payload = await webhookRequest<{ run: unknown }>(`/webhooks/${encodeURIComponent(webhook.id)}/runs/${encodeURIComponent(runId)}`)
      setRun(current => current?.runId === runId ? { runId, text: JSON.stringify(payload.run, null, 2), loading: false } : current)
    } catch (cause) {
      setRun(current => current?.runId === runId ? { runId, text: JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }, null, 2), loading: false } : current)
    }
  }
  const target = webhook.targetSessionId
  return (
    <aside className="min-w-0 rounded-xl border border-fw-border bg-fw-surface p-4 xl:sticky xl:top-4 xl:self-start" data-system-webhook-inspector={webhook.id}>
      <div className="flex items-start gap-2">
        <ActionIcon webhook={webhook} />
        <h2 className="min-w-0 flex-1 break-words text-sm font-semibold text-fw-text-strong">{webhook.id}</h2>
      </div>

      <section className={sectionClass}>
        <h3 className={headingClass}>Address</h3>
        <dl className="mt-1">
          <Field label="URL"><CopyAddress url={webhook.url} /></Field>
          <Field label="Verification">{webhookVerifyLabel(webhook)}</Field>
          {webhook.verify === 'github' ? <Field label="Events">{webhook.events.length ? webhook.events.join(', ') : 'All events'}</Field> : null}
        </dl>
        {isLocalWebhookUrl(webhook.url) ? (
          <p className="mt-2 text-xs leading-5 text-fw-text-muted" data-system-webhook-local>Set <code className="font-mono">url</code> in Setup › Config to the address outside services use to reach Foxwarm.</p>
        ) : null}
      </section>

      <section className={sectionClass}>
        <h3 className={headingClass}>Delivery</h3>
        <dl className="mt-1">
          <Field label="Session">
            {target ? (
              <span className="flex min-w-0 items-center gap-1">
                <button type="button" onClick={() => onInspectSession(target)} className="min-w-0 truncate text-left text-fw-accent hover:underline" data-system-webhook-target={target}>{target}</button>
                <button type="button" aria-label="Open target session" title="Open session" onClick={() => onOpenSession(target)} className="rounded p-0.5 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text"><ExternalLink className="h-3 w-3" /></button>
              </span>
            ) : (
              <span className="flex items-start gap-1 text-fw-danger" data-system-webhook-target-missing>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span><span className="font-mono">{webhook.session}</span> is unavailable. Deliveries are refused until it exists.</span>
              </span>
            )}
          </Field>
          <Field label="Action">{webhookActionLabel(webhook)}</Field>
          {webhook.script ? <>
            {webhook.script.filePath ? <Field label="Script file" mono>{webhook.script.filePath}</Field> : null}
            <Field label="Source node">{webhook.script.code !== undefined ? 'Inline' : webhook.script.node || 'Session’s current node'}</Field>
            <Field label="Timeout">{`${webhook.script.timeoutSecs ?? 30}s`}</Field>
            {webhook.script.code !== undefined ? <Field label="Code"><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-fw-surface-sunken p-2 font-mono text-[11px]">{webhook.script.code}</pre></Field> : null}
            {webhook.pending ? <Field label="Waiting">{`${webhook.pending} ${webhook.pending === 1 ? 'delivery' : 'deliveries'}`}</Field> : null}
          </> : null}
          {webhook.unauthorized ? (
            <Field label="Refused">{`${webhook.unauthorized} with a wrong secret or signature${webhook.lastUnauthorizedAt ? `, last ${formatPast(webhook.lastUnauthorizedAt, now)}` : ''}`}</Field>
          ) : null}
        </dl>
      </section>

      <section className={sectionClass}>
        <h3 className={headingClass}>Recent deliveries</h3>
        {webhook.deliveries.length ? (
          <ol className="mt-2 space-y-1.5" data-system-webhook-deliveries>
            {webhook.deliveries.map((delivery, index) => (
              <li key={`${delivery.at}-${index}`} className="rounded-lg border border-fw-border-muted px-2.5 py-1.5 text-xs" data-system-webhook-delivery={delivery.outcome}>
                <div className="flex min-w-0 items-center gap-2">
                  <OutcomeBadge delivery={delivery} />
                  <span className="min-w-0 flex-1 truncate text-fw-text-strong">{webhookDeliveryTitle(delivery)}</span>
                  <span className="shrink-0 text-fw-text-muted">{formatPast(delivery.at, now)}</span>
                </div>
                {delivery.deliveryId || delivery.runId ? (
                  <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-fw-text-muted">
                    {delivery.deliveryId ? <span className="min-w-0 truncate" title="Delivery ID">{delivery.deliveryId}</span> : null}
                    {delivery.runId ? <button type="button" onClick={() => { void openRun(delivery.runId!) }} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-fw-accent hover:underline" data-system-webhook-run={delivery.runId}>{delivery.runId}<ChevronRight className="h-3 w-3" /></button> : null}
                  </div>
                ) : null}
                {delivery.error ? <p className="mt-1 break-words text-fw-danger">{delivery.error}</p> : null}
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-xs text-fw-text-muted">Nothing has arrived since Foxwarm started.</p>}
      </section>
      {run ? <JsonInspectorDialog title={`Script run ${run.runId}`} text={run.text} loading={run.loading} onClose={() => setRun(null)} /> : null}
    </aside>
  )
}

export default function SystemWebhooks({ onInspectSession, onOpenSession }: {
  onInspectSession: (sessionId: string) => void
  onOpenSession: (sessionId: string) => void
}) {
  const { webhooks, loaded, error, reload } = useWebhookList()
  const now = useMinuteClock()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const ordered = useMemo(() => orderWebhooks(webhooks), [webhooks])
  useEffect(() => {
    if (selectedId && ordered.some(webhook => webhook.id === selectedId)) return
    setSelectedId(ordered[0]?.id || null)
  }, [ordered, selectedId])
  const selected = webhooks.find(webhook => webhook.id === selectedId) || null
  const attention = webhooks.filter(webhookNeedsAttention).length
  return (
    <div className="space-y-4" data-system-webhooks>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-xs text-fw-text-muted">Each webhook is an access identity in Setup › Config.</p>
        <div className="text-xs text-fw-text-muted" data-system-summary="webhooks">
          <strong className="font-semibold tabular-nums text-fw-text-strong">{webhooks.length}</strong> webhooks · <strong className="font-semibold tabular-nums text-fw-text-strong">{attention}</strong> need attention
        </div>
      </div>
      {error ? <div className="flex items-center justify-between gap-3 rounded-xl border border-fw-danger-border bg-fw-danger-section px-3 py-2 text-xs text-fw-danger"><span>{error}</span><button type="button" onClick={() => { void reload() }} className="font-medium underline">Retry</button></div> : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <main className="min-w-0 space-y-2" data-system-webhook-list>
          {ordered.map(webhook => <WebhookRowCard key={webhook.id} webhook={webhook} selected={webhook.id === selectedId} now={now} onSelect={() => setSelectedId(webhook.id)} />)}
          {loaded && !error && ordered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-fw-border-strong px-6 py-10 text-center text-sm text-fw-text-muted">
              No webhooks yet. Add an identity with a <code className="font-mono">webhook</code> surface in Setup › Config to receive events from GitHub, Cloudflare or your own tools.
            </div>
          ) : null}
        </main>
        <WebhookInspector key={selected?.id || ''} webhook={selected} now={now} onInspectSession={onInspectSession} onOpenSession={onOpenSession} />
      </div>
    </div>
  )
}

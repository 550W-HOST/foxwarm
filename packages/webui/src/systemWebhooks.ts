// System › Webhooks: read-only projection of GET /api/webhooks.

export type WebhookOutcome =
  | 'delivered' | 'duplicate' | 'ignored' | 'queued' | 'running' | 'completed' | 'paused' | 'failed'
  | 'rejected' | 'rate-limited' | 'unavailable'

export type WebhookDelivery = {
  at: number
  outcome: WebhookOutcome
  status: number
  event?: string
  action?: string
  deliveryId?: string
  sessionId?: string
  runId?: string
  error?: string
}

export type WebhookRow = {
  id: string
  url: string
  session: string
  targetSessionId: string | null
  verify: 'github' | 'bearer' | 'header'
  header?: string
  events: string[]
  action: 'message' | 'toolscript'
  wake: boolean
  script?: { filePath?: string; code?: string; node?: string; timeoutSecs?: number }
  pending: number
  unauthorized: number
  lastUnauthorizedAt?: number
  deliveries: WebhookDelivery[]
}

export type WebhookTone = 'success' | 'danger' | 'warning' | 'muted' | 'active'

export const WEBHOOK_OUTCOME_LABELS: Record<WebhookOutcome, string> = {
  delivered: 'Delivered',
  duplicate: 'Duplicate',
  ignored: 'Ignored',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  paused: 'Paused',
  failed: 'Failed',
  rejected: 'Rejected',
  'rate-limited': 'Rate limited',
  unavailable: 'Not delivered',
}

export const webhookOutcomeTone = (outcome: string): WebhookTone =>
  outcome === 'delivered' || outcome === 'completed' ? 'success'
    : outcome === 'failed' || outcome === 'rejected' || outcome === 'unavailable' ? 'danger'
      : outcome === 'rate-limited' || outcome === 'paused' ? 'warning'
        : outcome === 'queued' || outcome === 'running' ? 'active'
          : 'muted'

export const webhookVerifyLabel = (row: Pick<WebhookRow, 'verify' | 'header'>) =>
  row.verify === 'github' ? 'GitHub signature'
    : row.verify === 'bearer' ? 'Bearer token'
      : `Secret in ${row.header || 'header'}`

export const webhookActionLabel = (row: Pick<WebhookRow, 'action' | 'wake'>) =>
  row.action === 'toolscript' ? 'Run a ToolScript handler'
    : row.wake ? 'Message the session' : 'Message the session without waking it'

/** Event and GitHub action of one delivery, such as `pull_request · opened`; empty without an event. */
export const webhookDeliveryTitle = (delivery: WebhookDelivery) =>
  [delivery.event, delivery.action].filter(Boolean).join(' · ')

/** A loopback address means `url` is not configured, so outside services cannot reach it. */
export const isLocalWebhookUrl = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  } catch {
    return false
  }
}

/** Webhooks needing attention first: unavailable target, then latest failure; otherwise by ID. */
export const webhookNeedsAttention = (row: WebhookRow) =>
  !row.targetSessionId || webhookOutcomeTone(row.deliveries[0]?.outcome || '') === 'danger'

export const orderWebhooks = (rows: WebhookRow[]) =>
  [...rows].sort((left, right) => Number(webhookNeedsAttention(right)) - Number(webhookNeedsAttention(left)) || left.id.localeCompare(right.id))

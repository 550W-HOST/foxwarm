import { API_BASE_PATH } from './config'

/** Installation activity from POST /api/activity (administrator only). */
export type ActivityKind =
  | 'exec' | 'files' | 'communicate' | 'sessions' | 'tasks' | 'nodes' | 'config' | 'timers'
  | 'browser' | 'mcp' | 'script' | 'other' | 'read' | 'internal'

export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'approval-rejected' | 'approval-expired' | 'cancelled' | 'skipped'

export type ActivityInitiator = { kind: string; id?: string | null; seq?: number | null }

export type ActivityItem = {
  key: string
  sessionId: string | null
  currentSessionId?: string | null
  currentAgent?: string | null
  deleted?: boolean
  title?: string | null
  seq: number | null
  sub: number | null
  agent: string | null
  startedAt: number
  durationMs: number | null
  origin: 'model' | 'timer-script' | 'webhook-script' | 'external-mcp' | string
  tool: string
  source: string | null
  server: string | null
  node: string | null
  action: string | null
  kind: ActivityKind
  outcome: ActivityOutcome | string
  errorType: string | null
  approval: string | null
  approver: string | null
  rules: Array<{ layer: string; id: string; effect: string }> | null
  summary: string | null
  anchorSeq: number | null
  initiator: ActivityInitiator | null
  runId: string | null
  principal: string | null
  refs: { paths?: string[]; execId?: string; cwd?: string; deliveries?: Array<{ sessionId: string; deliverySeq?: string }> } | null
}

export type ActivityPage = {
  items: ActivityItem[]
  hasMore: boolean
  next: { beforeTime: number; beforeKey: string } | null
  coverage: { complete: boolean; earliest: number | null }
}

export type ActivityFilters = {
  from?: number
  to?: number
  kind?: 'changes' | 'all' | ActivityKind
  outcome?: ActivityOutcome | 'problems'
  sessionId?: string
  tree?: boolean
  agent?: string
  executionAgent?: string
  node?: string
  tool?: string
  initiator?: string
  origin?: string
  text?: string
}

export const ACTIVITY_KINDS: Array<{ id: NonNullable<ActivityFilters['kind']>; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'all', label: 'All calls' },
  { id: 'exec', label: 'Commands' },
  { id: 'files', label: 'File changes' },
  { id: 'communicate', label: 'Messages and files sent' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'config', label: 'Configuration' },
  { id: 'timers', label: 'Timers' },
  { id: 'browser', label: 'Browser' },
  { id: 'mcp', label: 'MCP tools' },
  { id: 'read', label: 'Reads' },
  { id: 'other', label: 'Other' },
]

export const ACTIVITY_OUTCOMES: Array<{ id: '' | NonNullable<ActivityFilters['outcome']>; label: string }> = [
  { id: '', label: 'Any result' },
  { id: 'problems', label: 'Not completed' },
  { id: 'ok', label: 'Completed' },
  { id: 'error', label: 'Failed' },
  { id: 'denied', label: 'Denied by a rule' },
  { id: 'approval-rejected', label: 'Approval rejected' },
  { id: 'approval-expired', label: 'Approval expired' },
  { id: 'cancelled', label: 'Cancelled' },
]

export const ACTIVITY_ORIGINS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Any source' },
  { id: 'model', label: 'Session turns' },
  { id: 'timer-script', label: 'Timer scripts' },
  { id: 'webhook-script', label: 'Webhook scripts' },
  { id: 'external-mcp', label: 'External MCP clients' },
]

export const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Completed',
  error: 'Failed',
  denied: 'Denied',
  'approval-rejected': 'Rejected',
  'approval-expired': 'Expired',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
}

/** Who started the turn of a call, in words. Unknown stays unknown. */
export function activityInitiatorLabel(item: ActivityItem): string {
  if (item.origin === 'external-mcp') return item.principal ? `External client ${item.principal.replace(/^external:/, '')}` : 'External client'
  const initiator = item.initiator
  if (!initiator) return 'Not recorded'
  switch (initiator.kind) {
    case 'administrator': return 'Administrator'
    case 'identity': return initiator.id ? `Identity ${initiator.id}` : 'Scoped identity'
    case 'channel': return initiator.id ? `Channel ${initiator.id}` : 'Channel'
    case 'session': return initiator.id ? `Session ${initiator.id}` : 'Another session'
    case 'timer': return initiator.id ? `Timer ${initiator.id}` : 'Timer'
    case 'webhook': return initiator.id ? `Webhook ${initiator.id}` : 'Webhook'
    case 'user': return initiator.id ? `User (${initiator.id})` : 'User'
    case 'event': return 'Background event'
    default: return initiator.kind
  }
}

export function activityToolLabel(item: ActivityItem): string {
  const name = item.server ? `${item.server} · ${item.tool}` : item.tool
  return item.action ? `${name} ${item.action}` : name
}

export async function loadActivity(filters: ActivityFilters, cursor: ActivityPage['next'] = null, limit = 100, signal?: AbortSignal): Promise<ActivityPage> {
  const body: Record<string, unknown> = { limit }
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '' && value !== false) body[key] = value
  if (cursor) { body.beforeTime = cursor.beforeTime; body.beforeKey = cursor.beforeKey }
  const response = await fetch(`${API_BASE_PATH}/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload: any = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : `Activity request failed (${response.status})`)
  if (!payload || !Array.isArray(payload.items)) throw new Error('Activity is unavailable.')
  return payload as ActivityPage
}

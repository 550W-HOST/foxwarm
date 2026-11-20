import { API_BASE_PATH } from './config'

/** Installation activity from POST /api/activity (administrator only). */
export type ActivityKind =
  | 'exec' | 'files' | 'communicate' | 'sessions' | 'tasks' | 'nodes' | 'config' | 'timers'
  | 'browser' | 'mcp' | 'script' | 'other' | 'read' | 'internal'

export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'approval-rejected' | 'approval-expired' | 'cancelled' | 'skipped'

export type ActivityInitiator = { kind: string; id?: string | null; from?: string | null; seq?: number | null }

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
  initiator: ActivityInitiator | null
  runId: string | null
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
export function activityInitiatorLabel(item: Pick<ActivityItem, 'initiator'>): string {
  const initiator = item.initiator
  if (!initiator) return 'Not recorded'
  const id = initiator.id || ''
  switch (initiator.kind) {
    case 'administrator': return 'Administrator'
    case 'identity': return id || 'Scoped user'
    case 'user': return id === 'webui' ? 'WebUI user' : 'User'
    case 'channel': return initiator.from ? `${initiator.from} via ${id || 'a channel'}` : id ? `Channel ${id}` : 'Channel'
    case 'session': return id ? `Session ${id}` : 'Another session'
    case 'task': return id ? `Task ${id}${initiator.from ? ` from ${initiator.from}` : ''}` : 'Task'
    case 'timer': return id ? `Timer ${id}` : 'Timer'
    case 'webhook': return id ? `Webhook ${id}` : 'Webhook'
    case 'mcp-client': return id ? `MCP client ${id}` : 'MCP client'
    case 'mcp-server': return id ? `MCP server ${id}` : 'MCP server'
    case 'trigger': return 'Trigger'
    default: return INITIATOR_KINDS[initiator.kind] || 'Other'
  }
}

/** Initiator kinds as filter chip labels. */
export const INITIATOR_KINDS: Record<string, string> = {
  administrator: 'Administrator',
  identity: 'Scoped users',
  user: 'Users',
  channel: 'Channels',
  session: 'Other sessions',
  task: 'Tasks',
  timer: 'Timers',
  webhook: 'Webhooks',
  'mcp-client': 'MCP clients',
  'mcp-server': 'MCP servers',
  trigger: 'Triggers',
}

export function activityToolLabel(item: Pick<ActivityItem, 'tool' | 'server' | 'action'>): string {
  const name = item.server ? `${item.server} · ${item.tool}` : item.tool
  return item.action ? `${name} ${item.action}` : name
}

/** Where a tool comes from, for the detail view. */
export function activitySourceLabel(item: Pick<ActivityItem, 'source' | 'server'>): string | null {
  switch (item.source) {
    case 'builtin': return 'Built-in tool'
    case 'node': return 'Node tool'
    case 'mcp': return item.server ? `MCP server ${item.server}` : 'MCP tool'
    default: return null
  }
}

/** Who decided an approval: the administrator or a scoped user's name. */
export function activityApproverLabel(approver: string | null): string | null {
  if (!approver) return null
  if (approver === 'administrator') return 'Administrator'
  return approver.replace(/^identity:/, '')
}

const APPROVAL_LABELS: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired', pending: 'Waiting for approval' }

export function activityApprovalLabel(approval: string | null): string | null {
  if (!approval) return null
  return APPROVAL_LABELS[approval] || humanize(approval)
}

const ERROR_LABELS: Record<string, string> = {
  tool_authorization_denied: 'Denied by a rule',
  tool_approval_rejected: 'Approval rejected',
  tool_approval_expired: 'Approval expired',
  tool_approval_unavailable: 'Approval unavailable',
  tool_call_skipped: 'Skipped',
  external_call_failed: 'The call failed',
}

export function activityErrorLabel(errorType: string | null): string | null {
  if (!errorType) return null
  return ERROR_LABELS[errorType] || humanize(errorType)
}

const RULE_EFFECTS: Record<string, string> = { allow: 'Allow', deny: 'Deny', ask: 'Ask for approval', approve: 'Ask for approval' }

/** One deciding rule: its policy layer, rule and effect. */
export function activityRuleLabel(rule: { layer: string; id: string; effect: string }): string {
  const layer = rule.layer === 'global' ? 'Global rules' : rule.layer.startsWith('agent:') ? `Agent ${rule.layer.slice(6)} rules` : rule.layer
  const id = rule.id === 'defaultAction' ? 'Default action' : rule.id
  return `${layer} · ${id} · ${RULE_EFFECTS[rule.effect] || humanize(rule.effect)}`
}

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : value
}

const newerThan = (a: ActivityItem, b: ActivityItem) => a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.key > b.key)

/**
 * Puts a fresh first page on top of the loaded list. Loaded rows older than the fresh page stay,
 * with the cursor that continues after them. Returns null when the fresh page does not reach the
 * loaded rows, so the caller can fetch the rows between them first.
 */
export function mergeActivity(
  loaded: { items: ActivityItem[]; next: ActivityPage['next'] },
  fresh: { items: ActivityItem[]; next: ActivityPage['next'] },
): { items: ActivityItem[]; next: ActivityPage['next'] } | null {
  // A page without more rows is the whole list.
  if (!loaded.items.length || !fresh.next) return fresh
  const keys = new Set(fresh.items.map(item => item.key))
  const last = fresh.items.at(-1)
  const reached = loaded.items.some(item => keys.has(item.key)) || (last !== undefined && !newerThan(last, loaded.items[0]))
  if (!reached) return null
  const older = loaded.items.filter(item => !keys.has(item.key) && (!last || newerThan(last, item)))
  return { items: [...fresh.items, ...older], next: older.length ? loaded.next : fresh.next }
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

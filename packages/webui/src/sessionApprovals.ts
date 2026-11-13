import { API_BASE_PATH } from './config'

export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'

/** A tool call that matched an `ask` rule, as recorded by its Session. */
export interface ToolApprovalRecord {
  id: string
  status: ToolApprovalStatus
  createdAt?: number
  origin?: 'turn' | 'script' | 'timer' | 'webhook' | 'runtime'
  tool: { source?: string; name: string; server?: string; executionNode?: string; invocationName?: string }
  summary?: string
  /** Where an exec command runs; absent when the Node uses its own default. */
  workingDirectory?: string
  timeoutSeconds?: number
  expiresAt?: number
  toolCallId?: string
  runId?: string
  args?: unknown
  argsPreview?: string
  argsTruncated?: true
  facts?: {
    paths?: Array<{ arg?: string; raw?: string; resolved?: string; node?: string }>
    nodeTargets?: string[]
    sessionTarget?: { id?: string; agent?: string; parent?: string }
    secrets?: string[]
  }
  rules?: Array<{ layer: string; id: string; reason?: string }>
  approvers?: string[]
  decidedAt?: number
  decidedBy?: { kind: 'administrator' | 'identity' | 'system'; id?: string; reason?: string }
  /** The approval of a call that then ended without running. */
  approvedBy?: ToolApprovalRecord['decidedBy']
  approvedAt?: number
  note?: string
  /** Whether the current WebUI identity may decide this pending request. */
  canDecide?: boolean
}

/** Presentation-only approval outcome stored beside a tool result. */
export interface ToolApprovalMeta {
  id: string
  status: ToolApprovalStatus
  decidedBy?: ToolApprovalRecord['decidedBy']
  decidedAt?: number
  approvedBy?: ToolApprovalRecord['decidedBy']
  approvedAt?: number
  note?: string
}

export interface ApprovalDecisionBody {
  decision: 'approve' | 'reject'
  note?: string
}

export function buildApprovalDecisionBody(decision: ApprovalDecisionBody['decision'], note: string): ApprovalDecisionBody {
  return note.trim() ? { decision, note: note.trim() } : { decision }
}

/** Tool identity as an approver reads it: MCP tools carry their server. */
export function approvalToolLabel(tool: ToolApprovalRecord['tool']): string {
  // Front ends (ctl, the former call_tool) show the capability they run.
  const name = tool.invocationName && tool.invocationName !== 'ctl' && tool.invocationName !== 'call_tool' ? tool.invocationName : tool.name
  return tool.source === 'mcp' && tool.server ? `${tool.server} · ${name}` : name
}

export function approvalStatusLabel(status: ToolApprovalStatus): string {
  switch (status) {
    case 'approved': return 'Approved'
    case 'rejected': return 'Rejected'
    case 'expired': return 'Expired'
    case 'cancelled': return 'Cancelled'
    default: return 'Waiting for approval'
  }
}

/** Who or what settled a request, when that adds information to its status. */
export function approvalDeciderLabel(approval: Pick<ToolApprovalMeta, 'status' | 'decidedBy'>): string {
  const by = approval.decidedBy
  if (!by) return ''
  if (by.kind === 'identity' && by.id) return `by ${by.id}`
  if (by.kind === 'system' && by.reason === 'restart') return 'at restart'
  if (by.kind === 'system' && by.reason === 'stop') return 'by Stop'
  if (by.kind === 'system' && by.reason === 'shutdown') return 'at shutdown'
  return ''
}

/** One-line outcome, for example "Approved by reviewer" or "Approved by reviewer · cancelled by Stop". */
export function describeApprovalOutcome(approval: Pick<ToolApprovalMeta, 'status' | 'decidedBy' | 'approvedBy'>): string {
  if (approval.status === 'cancelled' && approval.approvedBy) {
    const approved = ['Approved', approvalDeciderLabel({ status: 'approved', decidedBy: approval.approvedBy })].filter(Boolean).join(' ')
    const ended = approvalDeciderLabel(approval)
    return `${approved} · ${ended ? `cancelled ${ended}` : 'not run'}`
  }
  return [approvalStatusLabel(approval.status), approvalDeciderLabel(approval)].filter(Boolean).join(' ')
}

/** Where an exec command will run, as the approver reads it; empty for other tools. */
export function approvalWorkingDirectoryLabel(record: Pick<ToolApprovalRecord, 'tool' | 'workingDirectory'>): string {
  if (record.workingDirectory) return `in ${record.workingDirectory}`
  return record.tool.source === 'node' && record.tool.name === 'exec' ? "in the Node's default directory" : ''
}

/** Remaining time before a pending request expires, such as "4m left"; empty without a deadline. */
export function approvalTimeLeft(expiresAt: number | undefined, now = Date.now()): string {
  if (!expiresAt) return ''
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  if (seconds < 60) return `${seconds}s left`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 120) return `${minutes}m left`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h left` : `${Math.round(hours / 24)}d left`
}

/** Argument text for review: stored arguments, or the stored preview when they were too large. */
export function approvalArgsText(record: Pick<ToolApprovalRecord, 'args' | 'argsPreview' | 'argsTruncated'>): string {
  if (record.argsTruncated) return `${record.argsPreview || ''}…`
  if (record.args === undefined) return ''
  return JSON.stringify(record.args, null, 2)
}

/**
 * Resolved targets the asking rules matched on: paths with their Node, other Nodes, Sessions and
 * stored secrets the call would send to a new destination. The execution Node is already shown
 * with the tool.
 */
export function approvalTargets(record: Pick<ToolApprovalRecord, 'facts' | 'tool'>): string[] {
  const facts = record.facts
  if (!facts) return []
  const targets: string[] = []
  for (const path of facts.paths || []) {
    const value = path.resolved || path.raw
    if (value) targets.push(path.node ? `${path.node}:${value}` : value)
  }
  for (const node of facts.nodeTargets || []) if (node !== record.tool?.executionNode) targets.push(`Node ${node}`)
  if (facts.sessionTarget?.id) targets.push(`Session ${facts.sessionTarget.id}`)
  for (const name of facts.secrets || []) targets.push(`Secret ${name}`)
  return targets
}

export function approvalOriginLabel(origin: ToolApprovalRecord['origin']): string {
  switch (origin) {
    case 'script': return 'From a script'
    case 'timer': return 'From a scheduled run'
    case 'webhook': return 'From a webhook'
    default: return ''
  }
}

export class ApprovalDecisionError extends Error {
  constructor(message: string, readonly status: number, readonly notPending: boolean) { super(message) }
}

export async function fetchApprovalArgs(sessionId: string, approvalId: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, { signal })
  if (!response.ok) throw new Error(`Arguments could not be loaded (${response.status})`)
  const payload = await response.json()
  if (payload?.args === undefined) throw new Error('The full arguments are no longer available.')
  return payload.args
}

export async function submitApprovalDecision(sessionId: string, approvalId: string, body: ApprovalDecisionBody): Promise<void> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.ok) return
  const payload = await response.json().catch(() => ({}))
  throw new ApprovalDecisionError(typeof payload?.error === 'string' ? payload.error : `The decision could not be sent (${response.status})`, response.status, payload?.code === 'APPROVAL_NOT_PENDING')
}

import crypto from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import { WebSocket } from 'ws'
import { NODES_FILE } from '../config'

export type NodeToolDefinition = {
  name: string
  description: string
  parameters?: any
}

export type NodeCapabilitiesSnapshot = {
  tools: NodeToolDefinition[]
}

export type ApprovedNodeRecord = {
  nodeId: string
  nodeType: string
  requestedName?: string
  displayName?: string
  tokenHash: string
  createdAt: number
  updatedAt: number
  lastSeenAt?: number
  capabilities?: NodeCapabilitiesSnapshot
}

export type PendingPairingRecord = {
  id: string
  requestedName?: string
  nodeType: string
  requestedAt: number
  updatedAt: number
  pairCode: string
  capabilities: NodeCapabilitiesSnapshot
}

type NodeRegistryData = {
  approvedNodes: Record<string, ApprovedNodeRecord>
  pendingPairings: Record<string, PendingPairingRecord>
}

const RESERVED_NODE_IDS = new Set(['master'])
const DEFAULT_REGISTRY: NodeRegistryData = {
  approvedNodes: {},
  pendingPairings: {},
}

let registryData: NodeRegistryData | null = null
const pendingSockets = new Map<string, WebSocket>()

function cloneDefaultRegistry(): NodeRegistryData {
  return {
    approvedNodes: {},
    pendingPairings: {},
  }
}

async function loadRegistry(): Promise<NodeRegistryData> {
  if (registryData) {
    return registryData
  }

  if (!await fs.pathExists(NODES_FILE)) {
    registryData = cloneDefaultRegistry()
    return registryData
  }

  const raw = await fs.readJSON(NODES_FILE)
  registryData = {
    approvedNodes: raw?.approvedNodes || {},
    pendingPairings: raw?.pendingPairings || {},
  }
  return registryData
}

async function saveRegistry(): Promise<void> {
  const data = await loadRegistry()
  await fs.ensureDir(path.dirname(NODES_FILE))
  const tempPath = `${NODES_FILE}.tmp`
  await fs.writeJSON(tempPath, data, { spaces: 2 })
  await fs.move(tempPath, NODES_FILE, { overwrite: true })
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

function sanitizeNodeId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

  return sanitized || 'node'
}

function generatePairCode(): string {
  return String(Math.floor(Math.random() * 900000) + 100000)
}

function assertNodeIdAllowed(nodeId: string): void {
  if (!nodeId || !/^[a-zA-Z0-9_-]+$/.test(nodeId)) {
    throw new Error('Node id must match [a-zA-Z0-9_-]+')
  }
  if (RESERVED_NODE_IDS.has(nodeId)) {
    throw new Error(`Node id \`${nodeId}\` is reserved`)
  }
}

async function allocateUniqueNodeId(base: string): Promise<string> {
  const data = await loadRegistry()
  let candidate = sanitizeNodeId(base)
  if (RESERVED_NODE_IDS.has(candidate)) {
    candidate = `${candidate}-node`
  }

  if (!data.approvedNodes[candidate]) {
    return candidate
  }

  let suffix = 2
  while (data.approvedNodes[`${candidate}-${suffix}`]) {
    suffix += 1
  }
  return `${candidate}-${suffix}`
}

export async function initializeNodeRegistry(): Promise<void> {
  await loadRegistry()
}

export function isReservedNodeId(nodeId: string): boolean {
  return RESERVED_NODE_IDS.has(nodeId)
}

export async function createPendingPairing(input: {
  requestedName?: string
  nodeType: string
  capabilities: NodeCapabilitiesSnapshot
}): Promise<PendingPairingRecord> {
  const data = await loadRegistry()
  const now = Date.now()
  const pending: PendingPairingRecord = {
    id: `pair_${now}_${crypto.randomBytes(4).toString('hex')}`,
    requestedName: input.requestedName?.trim() || undefined,
    nodeType: input.nodeType,
    requestedAt: now,
    updatedAt: now,
    pairCode: generatePairCode(),
    capabilities: input.capabilities,
  }
  data.pendingPairings[pending.id] = pending
  await saveRegistry()
  return pending
}

export function attachPendingPairingSocket(pendingId: string, ws: WebSocket): void {
  pendingSockets.set(pendingId, ws)
}

export function detachPendingPairingSocket(pendingId: string): void {
  pendingSockets.delete(pendingId)
}

export async function listPendingPairings(): Promise<Array<PendingPairingRecord & { connected: boolean }>> {
  const data = await loadRegistry()
  return Object.values(data.pendingPairings)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(entry => ({ ...entry, connected: pendingSockets.has(entry.id) }))
}

export async function listApprovedNodes(): Promise<ApprovedNodeRecord[]> {
  const data = await loadRegistry()
  return Object.values(data.approvedNodes).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

export async function authenticateApprovedNode(nodeId: string, authToken: string): Promise<ApprovedNodeRecord | null> {
  if (!nodeId || !authToken) {
    return null
  }
  const data = await loadRegistry()
  const record = data.approvedNodes[nodeId]
  if (!record) {
    return null
  }
  if (record.tokenHash !== hashToken(authToken)) {
    return null
  }
  return record
}

export async function touchApprovedNode(nodeId: string, update: Partial<Pick<ApprovedNodeRecord, 'lastSeenAt' | 'updatedAt' | 'capabilities' | 'nodeType' | 'requestedName' | 'displayName'>> = {}): Promise<void> {
  const data = await loadRegistry()
  const record = data.approvedNodes[nodeId]
  if (!record) {
    return
  }
  data.approvedNodes[nodeId] = {
    ...record,
    ...update,
    updatedAt: update.updatedAt ?? Date.now(),
  }
  await saveRegistry()
}

export async function approvePendingPairing(pendingId: string, requestedNodeId?: string): Promise<{
  nodeId: string
  authToken: string
  pending: PendingPairingRecord
  deliveredLive: boolean
}> {
  const data = await loadRegistry()
  const pending = data.pendingPairings[pendingId]
  if (!pending) {
    throw new Error(`Pending pairing \`${pendingId}\` not found`)
  }

  let nodeId: string
  if (requestedNodeId && requestedNodeId.trim()) {
    assertNodeIdAllowed(requestedNodeId.trim())
    if (data.approvedNodes[requestedNodeId.trim()]) {
      throw new Error(`Node id \`${requestedNodeId.trim()}\` already exists`)
    }
    nodeId = requestedNodeId.trim()
  } else {
    nodeId = await allocateUniqueNodeId(pending.requestedName || pending.nodeType || 'node')
  }

  const authToken = randomToken(32)
  const now = Date.now()
  data.approvedNodes[nodeId] = {
    nodeId,
    nodeType: pending.nodeType,
    requestedName: pending.requestedName,
    displayName: pending.requestedName || nodeId,
    tokenHash: hashToken(authToken),
    createdAt: now,
    updatedAt: now,
    capabilities: pending.capabilities,
  }
  delete data.pendingPairings[pendingId]
  await saveRegistry()

  let deliveredLive = false
  const ws = pendingSockets.get(pendingId)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'pair_approved',
      pendingId,
      nodeId,
      authToken,
    }))
    try {
      ws.close(1000, 'Pairing approved; reconnect with node credentials')
    } catch {}
    deliveredLive = true
  }
  pendingSockets.delete(pendingId)

  return { nodeId, authToken, pending, deliveredLive }
}

export async function rejectPendingPairing(pendingId: string, reason?: string): Promise<void> {
  const data = await loadRegistry()
  const pending = data.pendingPairings[pendingId]
  if (!pending) {
    throw new Error(`Pending pairing \`${pendingId}\` not found`)
  }
  delete data.pendingPairings[pendingId]
  await saveRegistry()

  const ws = pendingSockets.get(pendingId)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'pair_rejected',
      pendingId,
      reason: reason || 'Pairing request rejected',
    }))
    try {
      ws.close(1008, reason || 'Pairing request rejected')
    } catch {}
  }
  pendingSockets.delete(pendingId)
}

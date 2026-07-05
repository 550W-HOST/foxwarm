import crypto from 'crypto'
import { WebSocket } from 'ws'
import { NODES_FILE } from '../config'
import { logger } from '../common'
import { DiskJsonData } from '../utils/diskJsonData'

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
  /** Set when approved but not yet delivered to the client */
  approvedNodeId?: string
  /** Plaintext auth token — stored temporarily until client picks it up */
  approvedAuthToken?: string
  approvedAt?: number
}

type NodeRegistryData = {
  approvedNodes: Record<string, ApprovedNodeRecord>
  pendingPairings: Record<string, PendingPairingRecord>
}

export const PENDING_PAIRING_TTL_MS = 60 * 60 * 1000

const RESERVED_NODE_IDS = new Set(['master'])

let registryData: NodeRegistryData | null = null
const pendingSockets = new Map<string, WebSocket>()

function normalizeRegistryData(raw: any, filePath: string): NodeRegistryData {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid node registry payload in ${filePath}`)
  }

  return {
    approvedNodes: raw.approvedNodes && typeof raw.approvedNodes === 'object' ? raw.approvedNodes : {},
    pendingPairings: raw.pendingPairings && typeof raw.pendingPairings === 'object' ? raw.pendingPairings : {},
  }
}

export function createNodeRegistryStore(filePath: string = NODES_FILE): DiskJsonData<NodeRegistryData> {
  return new DiskJsonData<NodeRegistryData>(filePath, {
    backup: {
      rotate: 3,
      includeLegacyBak: true,
      bestEffort: true,
    },
    normalizeLoadedData: normalizeRegistryData,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read node registry candidate')
    },
    onBackupError: (err: unknown) => {
      logger.warn({ err }, 'Failed to rotate node registry backups')
    },
  })
}

let registryStore = createNodeRegistryStore()

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

  const loaded = await registryStore.loadFirstAvailable()
  if (!loaded) {
    registryData = cloneDefaultRegistry()
    return registryData
  }

  registryData = loaded.data
  if (loaded.source !== registryStore.filePath) {
    logger.warn({ source: loaded.source }, 'Recovering node registry from fallback source')
    await registryStore.write(registryData)
  }

  return registryData
}

async function saveRegistry(): Promise<void> {
  const data = await loadRegistry()
  await registryStore.write(data)
}

export function setNodeRegistryStoreForTests(store: DiskJsonData<NodeRegistryData> | null): void {
  registryStore = store || createNodeRegistryStore()
  registryData = null
}

export function resetNodeRegistryForTests(): void {
  registryData = null
  pendingSockets.clear()
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
  if (RESERVED_NODE_IDS.has(nodeId.toLowerCase())) {
    throw new Error(`Node id \`${nodeId}\` is reserved`)
  }
}

function normalizeExplicitNodeId(value: string): string {
  const nodeId = value.trim()
  assertNodeIdAllowed(nodeId)
  return nodeId
}

function normalizeNewNodeId(value: string): string {
  const nodeId = value.trim()
  const sanitized = sanitizeNodeId(nodeId)
  if (RESERVED_NODE_IDS.has(sanitized.toLowerCase()) || RESERVED_NODE_IDS.has(nodeId.toLowerCase())) {
    throw new Error(`Node id \`${nodeId}\` is reserved`)
  }
  if (sanitized !== nodeId) {
    throw new Error(`Node id \`${nodeId}\` must already be in sanitized form. Suggested id: \`${sanitized}\``)
  }
  assertNodeIdAllowed(nodeId)
  return nodeId
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
  await cleanupExpiredPendingPairings()
}

export function isReservedNodeId(nodeId: string): boolean {
  return RESERVED_NODE_IDS.has(nodeId.toLowerCase())
}

export async function createPendingPairing(input: {
  requestedName?: string
  nodeType: string
  capabilities: NodeCapabilitiesSnapshot
}): Promise<PendingPairingRecord> {
  await cleanupExpiredPendingPairings()
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
  await cleanupExpiredPendingPairings()
  const data = await loadRegistry()
  return Object.values(data.pendingPairings)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(entry => ({ ...entry, connected: pendingSockets.has(entry.id) }))
}

export async function listApprovedNodes(): Promise<ApprovedNodeRecord[]> {
  await cleanupExpiredPendingPairings()
  const data = await loadRegistry()
  return Object.values(data.approvedNodes).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

export async function removeApprovedNode(nodeIdInput: string): Promise<ApprovedNodeRecord> {
  const nodeId = normalizeExplicitNodeId(nodeIdInput)
  await cleanupExpiredPendingPairings()
  const data = await loadRegistry()
  const record = data.approvedNodes[nodeId]
  if (!record) {
    throw new Error(`Approved node \`${nodeId}\` not found`)
  }

  delete data.approvedNodes[nodeId]
  for (const [pendingId, pending] of Object.entries(data.pendingPairings)) {
    if (pending.approvedNodeId === nodeId) {
      delete data.pendingPairings[pendingId]
    }
  }

  await saveRegistry()
  return record
}

export async function moveApprovedNode(oldNodeIdInput: string, newNodeIdInput: string): Promise<{
  oldNodeId: string
  newNodeId: string
  record: ApprovedNodeRecord
}> {
  const oldNodeId = normalizeExplicitNodeId(oldNodeIdInput)
  const newNodeId = normalizeNewNodeId(newNodeIdInput)
  if (oldNodeId === newNodeId) {
    throw new Error('New node id must be different from the old node id')
  }

  await cleanupExpiredPendingPairings()
  const data = await loadRegistry()
  const record = data.approvedNodes[oldNodeId]
  if (!record) {
    throw new Error(`Approved node \`${oldNodeId}\` not found`)
  }
  if (data.approvedNodes[newNodeId]) {
    throw new Error(`Node id \`${newNodeId}\` already exists`)
  }

  const movedRecord: ApprovedNodeRecord = {
    ...record,
    nodeId: newNodeId,
    displayName: record.displayName === oldNodeId ? newNodeId : record.displayName,
    updatedAt: Date.now(),
  }
  data.approvedNodes[newNodeId] = movedRecord
  delete data.approvedNodes[oldNodeId]

  for (const pending of Object.values(data.pendingPairings)) {
    if (pending.approvedNodeId === oldNodeId) {
      pending.approvedNodeId = newNodeId
      pending.updatedAt = Date.now()
    }
  }

  await saveRegistry()
  return { oldNodeId, newNodeId, record: movedRecord }
}

function getPendingPairingExpiryTimestamp(record: PendingPairingRecord): number {
  return Number(record.approvedAt) || Number(record.requestedAt) || Number(record.updatedAt) || 0
}

function isPendingPairingExpired(record: PendingPairingRecord, now = Date.now()): boolean {
  const expiresFrom = getPendingPairingExpiryTimestamp(record)
  return expiresFrom > 0 && now - expiresFrom > PENDING_PAIRING_TTL_MS
}

export async function cleanupExpiredPendingPairings(now = Date.now()): Promise<number> {
  const data = await loadRegistry()
  const expired = Object.entries(data.pendingPairings)
    .filter(([, record]) => isPendingPairingExpired(record, now))

  if (expired.length === 0) {
    return 0
  }

  for (const [pendingId, record] of expired) {
    delete data.pendingPairings[pendingId]

    if (record.approvedNodeId) {
      delete data.approvedNodes[record.approvedNodeId]
    }

    const ws = pendingSockets.get(pendingId)
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'pair_rejected',
          pendingId,
          reason: 'Pairing request expired after 1 hour',
        }))
      } catch {}

      try {
        ws.close(1008, 'Pairing request expired after 1 hour')
      } catch {}
    }

    pendingSockets.delete(pendingId)
  }

  await saveRegistry()
  return expired.length
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
  await cleanupExpiredPendingPairings()
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
  } else {
    // Client is offline — keep the pending record with approval info
    // so the client can pick it up on next reconnect
    data.pendingPairings[pendingId] = {
      ...pending,
      approvedNodeId: nodeId,
      approvedAuthToken: authToken,
      approvedAt: now,
      updatedAt: now,
    }
    await saveRegistry()
  }
  pendingSockets.delete(pendingId)

  return { nodeId, authToken, pending, deliveredLive }
}

/** Check if a pending pairing has been approved offline. If so, claim it (delete pending, return credentials). */
export async function claimApprovedPairing(pendingId: string): Promise<{
  nodeId: string
  authToken: string
} | null> {
  await cleanupExpiredPendingPairings()
  const data = await loadRegistry()
  const pending = data.pendingPairings[pendingId]
  if (!pending || !pending.approvedNodeId || !pending.approvedAuthToken) {
    return null
  }
  const { approvedNodeId, approvedAuthToken } = pending
  delete data.pendingPairings[pendingId]
  await saveRegistry()
  return { nodeId: approvedNodeId, authToken: approvedAuthToken }
}

export async function rejectPendingPairing(pendingId: string, reason?: string): Promise<void> {
  await cleanupExpiredPendingPairings()
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

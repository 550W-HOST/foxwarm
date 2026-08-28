export type WebUiNodeTarget = {
  id: string
  type: string
  displayName: string
  online: boolean
  lastSeenAt?: number
  services: Record<string, number>
  unavailable?: boolean
  protocolStatus?: 'compatible' | 'upgrade-required'
  protocolMessage?: string
}

export type NodeTargetService = 'vscode-fs' | 'vscode-pty'

const NODE_ID_RE = /^[A-Za-z0-9._-]+$/

export const MASTER_NODE_TARGET: WebUiNodeTarget = {
  id: 'master',
  type: 'master',
  displayName: 'master',
  online: true,
  services: {},
}

export function normalizeNodeId(value: unknown, fallback = 'master'): string {
  return typeof value === 'string' && NODE_ID_RE.test(value.trim()) ? value.trim() : fallback
}

export function parseWebUiNodeTargets(payload: unknown): WebUiNodeTarget[] {
  const rawNodes = payload && typeof payload === 'object' && Array.isArray((payload as { nodes?: unknown }).nodes)
    ? (payload as { nodes: unknown[] }).nodes
    : []
  const byId = new Map<string, WebUiNodeTarget>()
  byId.set('master', MASTER_NODE_TARGET)

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = normalizeNodeId(item.id, '')
    if (!id) continue
    const services: Record<string, number> = {}
    if (item.services && typeof item.services === 'object' && !Array.isArray(item.services)) {
      for (const [name, version] of Object.entries(item.services as Record<string, unknown>)) {
        if (Number.isInteger(version) && Number(version) > 0) services[name] = Number(version)
      }
    }
    byId.set(id, id === 'master' ? MASTER_NODE_TARGET : {
      id,
      type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'remote',
      displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim() : id,
      online: item.online === true,
      ...(Number.isFinite(item.lastSeenAt) ? { lastSeenAt: Number(item.lastSeenAt) } : {}),
      services,
      ...(
        item.protocolCompatibility && typeof item.protocolCompatibility === 'object'
        && (item.protocolCompatibility as Record<string, unknown>).status === 'upgrade-required'
          ? {
              protocolStatus: 'upgrade-required' as const,
              protocolMessage: typeof (item.protocolCompatibility as Record<string, unknown>).client === 'object'
                && typeof (item.protocolCompatibility as Record<string, unknown>).master === 'object'
                ? 'upgrade required'
                : 'protocol incompatible',
            }
          : { protocolStatus: 'compatible' as const }
      ),
    })
  }

  return [...byId.values()]
}

export function preserveSelectedNodeTarget(nodes: readonly WebUiNodeTarget[], selectedNodeId: string): WebUiNodeTarget[] {
  const normalizedId = normalizeNodeId(selectedNodeId)
  if (nodes.some(node => node.id === normalizedId)) return [...nodes]
  return [...nodes, {
    id: normalizedId,
    type: 'unavailable',
    displayName: normalizedId,
    online: false,
    services: {},
    unavailable: true,
  }]
}

export function getNodeTargetAvailability(node: WebUiNodeTarget, service: NodeTargetService): { available: boolean; reason?: string } {
  if (node.id === 'master') return { available: true }
  if (node.unavailable) return { available: false, reason: 'unavailable' }
  if (!node.online) return { available: false, reason: node.protocolStatus === 'upgrade-required' ? 'offline · upgrade required' : 'offline' }
  if (node.protocolStatus === 'upgrade-required') return { available: false, reason: node.protocolMessage || 'upgrade required' }
  if (Number(node.services[service] || 0) < 1) {
    return { available: false, reason: service === 'vscode-pty' ? 'terminal unavailable' : 'filesystem unavailable' }
  }
  return { available: true }
}

export function formatNodeTargetLabel(node: WebUiNodeTarget, service: NodeTargetService): string {
  const name = node.displayName && node.displayName !== node.id
    ? `${node.displayName} (${node.id})`
    : node.id
  if (node.id === 'master') return `${name} · local`
  const availability = getNodeTargetAvailability(node, service)
  if (!availability.available) return `${name} · ${availability.reason}`
  if (service === 'vscode-fs' && Number(node.services['vscode-git'] || 0) < 1) return `${name} · online · no Git`
  return `${name} · online`
}
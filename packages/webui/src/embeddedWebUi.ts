export const FOXWARM_EMBED_CHANNEL = 'foxwarm-webui-embed'
export const FOXWARM_EMBED_HOST_CHANNEL = 'foxwarm-webui-host'
export const FOXWARM_EMBED_VERSION = 1

export type FoxwarmEmbeddedTarget =
  | { kind: 'sidebar'; nonce: string }
  | { kind: 'chat'; nonce: string; sessionId: string; title?: string }
  | { kind: 'agents'; nonce: string }
  | { kind: 'setup'; nonce: string }

export type FoxwarmActiveTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'agents' }
  | { kind: 'setup' }

export type FoxwarmEmbedHostPayload =
  | { type: 'sidebar-ready' }
  | { type: 'open-session'; sessionId: string; title?: string }
  | { type: 'open-agents' }
  | { type: 'open-setup' }
  | { type: 'open-terminal' }
  | { type: 'open-commit'; nodeId: string; path: string; commitId: string }

const normalizeNonce = (value: string | null): string | null => {
  if (!value || !/^[A-Za-z0-9_-]{16,160}$/.test(value)) return null
  return value
}

const normalizeSessionId = (value: string | null): string | null => {
  if (!value) return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

export function parseFoxwarmEmbeddedTarget(search: string): FoxwarmEmbeddedTarget | null {
  const params = new URLSearchParams(search)
  const mode = params.get('foxwarmEmbed')
  const nonce = normalizeNonce(params.get('foxwarmEmbedNonce'))
  if (!nonce) return null
  if (mode === 'sidebar') return { kind: 'sidebar', nonce }
  if (mode === 'agents') return { kind: 'agents', nonce }
  if (mode === 'setup') return { kind: 'setup', nonce }
  if (mode !== 'chat') return null
  const sessionId = normalizeSessionId(params.get('sessionId'))
  if (!sessionId) return null
  const title = params.get('title')?.trim()
  return {
    kind: 'chat',
    nonce,
    sessionId,
    ...(title && title.length <= 200 ? { title } : {}),
  }
}

export function readFoxwarmActiveTargetMessage(value: unknown, nonce: string): FoxwarmActiveTarget | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const message = value as { channel?: unknown; version?: unknown; nonce?: unknown; type?: unknown; target?: unknown }
  if (message.channel !== FOXWARM_EMBED_HOST_CHANNEL || message.version !== FOXWARM_EMBED_VERSION || message.nonce !== nonce || message.type !== 'active-target') return undefined
  if (message.target === null) return null
  if (!message.target || typeof message.target !== 'object') return undefined
  const target = message.target as { kind?: unknown; sessionId?: unknown }
  if (target.kind === 'agents') return { kind: 'agents' }
  if (target.kind === 'setup') return { kind: 'setup' }
  if (target.kind !== 'session') return undefined
  const sessionId = normalizeSessionId(typeof target.sessionId === 'string' ? target.sessionId : null)
  return sessionId ? { kind: 'session', sessionId } : undefined
}

export function postFoxwarmEmbedHostMessage(nonce: string, payload: FoxwarmEmbedHostPayload): void {
  if (window.parent === window) return
  window.parent.postMessage({
    channel: FOXWARM_EMBED_CHANNEL,
    version: FOXWARM_EMBED_VERSION,
    nonce,
    ...payload,
  }, '*')
}

export function readEmbeddedSessionLink(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('a[href]') : null
  if (!(element instanceof HTMLAnchorElement)) return null
  const hash = new URL(element.href, window.location.href).hash
  if (!hash.startsWith('#session/')) return null
  try {
    return normalizeSessionId(decodeURIComponent(hash.slice('#session/'.length)))
  } catch {
    return null
  }
}

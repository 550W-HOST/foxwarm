import { makeWebSocketUrl } from './config'

export type WebUiRealtimeMessage = {
  type: string
  sessionId?: string
  revision?: number
  sessionResolutions?: Record<string, string>
  [key: string]: any
}

export type WebUiRealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type WebUiRealtimeHandlers = {
  onMessage: (message: WebUiRealtimeMessage) => void
  onOpen?: () => void
  onStatus?: (status: WebUiRealtimeStatus, retryInSeconds?: number) => void
}

type WebSocketLike = {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
}

type RealtimeOptions = {
  createSocket?: () => WebSocketLike
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  random?: () => number
}

type ListSubscription = { ids: Set<string>; handlers: WebUiRealtimeHandlers }
type SessionSubscription = { sessionId: string; handlers: WebUiRealtimeHandlers }

const SOCKET_OPEN = 1
const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * Page-scoped owner for WebUI realtime I/O. Components own logical
 * subscriptions only; this class guarantees that a page owns at most one
 * physical WebSocket regardless of sidebar, architecture, or split Chat count.
 */
export class WebUiRealtimeTransport {
  private readonly createSocket: () => WebSocketLike
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly random: () => number
  private readonly listSubscriptions = new Map<number, ListSubscription>()
  private readonly sessionSubscriptions = new Map<number, SessionSubscription>()
  private socket: WebSocketLike | null = null
  private reconnectTimer: unknown = null
  private nextSubscriptionId = 1
  private subscriptionRevision = 0
  private socketGeneration = 0
  private notifiedGeneration = 0
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  private status: WebUiRealtimeStatus = 'disconnected'
  private suspended = false
  private sessionResolutions = new Map<string, string>()

  constructor(options: RealtimeOptions = {}) {
    this.createSocket = options.createSocket || (() => new WebSocket(makeWebSocketUrl('/webui/stream')) as unknown as WebSocketLike)
    this.setTimer = options.setTimer || ((callback, delayMs) => window.setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer || (timer => window.clearTimeout(timer as number))
    this.random = options.random || Math.random
  }

  subscribeSessionList(ids: string[], handlers: WebUiRealtimeHandlers): () => void {
    const subscriptionId = this.nextSubscriptionId++
    this.listSubscriptions.set(subscriptionId, { ids: new Set(ids), handlers })
    this.subscriptionChanged()
    handlers.onStatus?.(this.status)
    return () => {
      if (!this.listSubscriptions.delete(subscriptionId)) return
      this.subscriptionChanged()
    }
  }

  subscribeSession(sessionId: string, handlers: WebUiRealtimeHandlers): () => void {
    const subscriptionId = this.nextSubscriptionId++
    this.sessionSubscriptions.set(subscriptionId, { sessionId, handlers })
    this.subscriptionChanged()
    handlers.onStatus?.(this.status)
    return () => {
      if (!this.sessionSubscriptions.delete(subscriptionId)) return
      this.subscriptionChanged()
    }
  }

  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.cancelReconnect()
    this.closeSocket(1000, 'Page suspended')
    this.setStatus('disconnected')
  }

  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    this.ensureConnected()
  }

  dispose(): void {
    this.suspended = true
    this.listSubscriptions.clear()
    this.sessionSubscriptions.clear()
    this.cancelReconnect()
    this.closeSocket(1000, 'Realtime transport disposed')
    this.setStatus('disconnected')
  }

  getUnderlyingConnectionCount(): number {
    return this.socket ? 1 : 0
  }

  private subscriptionChanged(): void {
    this.subscriptionRevision += 1
    this.sessionResolutions.clear()
    if (!this.hasSubscriptions()) {
      this.cancelReconnect()
      this.closeSocket(1000, 'No realtime subscribers')
      this.setStatus('disconnected')
      return
    }
    this.ensureConnected()
    this.sendSubscriptions()
  }

  private hasSubscriptions(): boolean {
    return this.listSubscriptions.size > 0 || this.sessionSubscriptions.size > 0
  }

  private ensureConnected(): void {
    if (this.suspended || !this.hasSubscriptions() || this.socket || this.reconnectTimer !== null) return
    const socket = this.createSocket()
    const generation = ++this.socketGeneration
    this.socket = socket
    this.sessionResolutions.clear()
    this.setStatus('connecting')

    socket.onopen = () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.sendSubscriptions()
    }
    socket.onmessage = event => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.handleMessage(event.data, generation)
    }
    socket.onerror = () => {
      if (!this.isCurrentSocket(socket, generation)) return
      socket.close()
    }
    socket.onclose = () => {
      if (!this.isCurrentSocket(socket, generation)) return
      this.socket = null
      this.scheduleReconnect()
    }
  }

  private handleMessage(raw: unknown, generation: number): void {
    let message: WebUiRealtimeMessage
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }

    if (message.type === 'subscriptions-accepted' && message.revision === this.subscriptionRevision) {
      this.sessionResolutions = new Map(Object.entries(message.sessionResolutions || {}))
      return
    }
    if (message.type === 'subscriptions-applied') {
      if (message.revision !== this.subscriptionRevision || generation === this.notifiedGeneration) return
      this.notifiedGeneration = generation
      this.setStatus('connected')
      this.forEachHandler(handlers => handlers.onOpen?.())
      return
    }
    if (message.type === 'connected' || message.type === 'protocol-error') return

    if (message.type === 'session-list-delta' || message.type === 'sessions-updated' || message.type === 'session-list-invalidated') {
      for (const subscription of this.listSubscriptions.values()) subscription.handlers.onMessage(message)
      return
    }

    if (!message.sessionId) return
    for (const subscription of this.sessionSubscriptions.values()) {
      const canonical = this.sessionResolutions.get(subscription.sessionId) || subscription.sessionId
      if (canonical === message.sessionId || subscription.sessionId === message.sessionId) {
        subscription.handlers.onMessage(message)
      }
    }
  }

  private sendSubscriptions(): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN || !this.hasSubscriptions()) return
    const sessionListIds = new Set<string>()
    for (const subscription of this.listSubscriptions.values()) {
      for (const id of subscription.ids) sessionListIds.add(id)
    }
    const sessionIds = new Set<string>()
    for (const subscription of this.sessionSubscriptions.values()) sessionIds.add(subscription.sessionId)
    this.socket.send(JSON.stringify({
      type: 'set-subscriptions',
      revision: this.subscriptionRevision,
      sessionListActive: this.listSubscriptions.size > 0,
      sessionListIds: [...sessionListIds],
      sessionIds: [...sessionIds],
    }))
  }

  private scheduleReconnect(): void {
    if (this.suspended || !this.hasSubscriptions() || this.reconnectTimer !== null) {
      if (!this.hasSubscriptions()) this.setStatus('disconnected')
      return
    }
    const baseDelay = this.reconnectDelayMs
    const delayMs = Math.max(1, Math.round(baseDelay * (0.8 + this.random() * 0.4)))
    this.reconnectDelayMs = Math.min(baseDelay * 2, MAX_RECONNECT_DELAY_MS)
    this.setStatus('reconnecting', Math.ceil(delayMs / 1000))
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      this.ensureConnected()
    }, delayMs)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) return
    this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    this.socketGeneration += 1
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close(code, reason)
  }

  private isCurrentSocket(socket: WebSocketLike, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation
  }

  private setStatus(status: WebUiRealtimeStatus, retryInSeconds?: number): void {
    this.status = status
    this.forEachHandler(handlers => handlers.onStatus?.(status, retryInSeconds))
  }

  private forEachHandler(callback: (handlers: WebUiRealtimeHandlers) => void): void {
    for (const subscription of this.listSubscriptions.values()) callback(subscription.handlers)
    for (const subscription of this.sessionSubscriptions.values()) callback(subscription.handlers)
  }
}

export const webUiRealtime = new WebUiRealtimeTransport()

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => webUiRealtime.suspend())
  window.addEventListener('pageshow', () => webUiRealtime.resume())
}

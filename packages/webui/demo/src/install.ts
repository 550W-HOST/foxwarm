// Installs the demo fetch, WebSocket and image-source shims before the WebUI boots.
import { createDemoServer, showReadOnlyNotice, type DemoServer, type DemoSnapshot } from './mock'

type Listener = (event: any) => void

// Answers the page-scoped realtime protocol from the recorded Session snapshots.
class DemoSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  extensions = ''
  protocol = ''
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null
  private listeners = new Map<string, Set<Listener>>()
  private sentSessions = new Set<string>()

  constructor(readonly url: string, private readonly server: DemoServer, private readonly realtime: boolean) {
    setTimeout(() => {
      if (this.readyState !== 0) return
      if (!this.realtime) {
        this.readyState = 3
        this.dispatch('error', { type: 'error' })
        this.dispatch('close', { type: 'close', code: 1011, reason: 'Not available in the demo', wasClean: false })
        return
      }
      this.readyState = 1
      this.dispatch('open', { type: 'open' })
      this.emit({ type: 'connected' })
    }, 0)
  }

  addEventListener(type: string, listener: Listener) {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, set = new Set())
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string) {
    if (this.readyState !== 1) return
    let message: any
    try { message = JSON.parse(String(data)) } catch { return }
    if (message?.type !== 'set-subscriptions') return
    const { snapshot, known } = this.server
    const listIds: string[] = (message.sessionListIds || []).filter((id: string) => known.has(id))
    const sessionIds: string[] = (message.sessionIds || []).filter((id: string) => known.has(id))
    this.emit({
      type: 'subscriptions-accepted',
      revision: message.revision,
      sessionResolutions: Object.fromEntries(sessionIds.map(id => [id, id])),
      sessionListResolutions: Object.fromEntries(listIds.map(id => [id, id])),
    })
    if (message.sessionListActive) {
      this.emit({ type: 'session-list-delta', deletedIds: [], sessions: listIds.map(id => snapshot.rows[id]).filter(Boolean) })
    }
    for (const id of sessionIds) {
      if (this.sentSessions.has(id)) continue
      this.sentSessions.add(id)
      for (const frame of snapshot.realtime[id] || []) this.emit(frame)
    }
    for (const id of [...this.sentSessions]) if (!sessionIds.includes(id)) this.sentSessions.delete(id)
    if (message.logs?.id) {
      this.emit({ type: 'logs-error', logsId: message.logs.id, message: 'Logs are not available in the demo.' })
    }
    this.emit({ type: 'subscriptions-applied', revision: message.revision })
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 3
    setTimeout(() => this.dispatch('close', { type: 'close', code, reason, wasClean: true }), 0)
  }

  private emit(message: unknown) {
    const data = JSON.stringify(message)
    setTimeout(() => { if (this.readyState === 1) this.dispatch('message', { type: 'message', data }) }, 0)
  }

  private dispatch(type: string, event: any) {
    const handler = (this as any)[`on${type}`] as Listener | null
    handler?.call(this, event)
    for (const listener of this.listeners.get(type) || []) listener.call(this, event)
  }
}

export function installDemo(snapshot: DemoSnapshot): DemoServer {
  const server = createDemoServer(snapshot)
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!server.handlesUrl(new URL(request.url))) return originalFetch(input, init)
    if (request.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    return server.handle(request)
  }

  const OriginalWebSocket = window.WebSocket
  const DemoWebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const resolved = new URL(String(url), window.location.href)
    const httpUrl = new URL(resolved)
    httpUrl.protocol = window.location.protocol
    if (!server.handlesUrl(httpUrl)) return new OriginalWebSocket(url, protocols)
    return new DemoSocket(resolved.toString(), server, httpUrl.pathname === `${server.apiBase}/webui/stream`)
  } as unknown as typeof WebSocket
  Object.assign(DemoWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  window.WebSocket = DemoWebSocket

  // Images, file previews and other element sources do not go through fetch.
  const rewrite = (value: unknown) => typeof value === 'string' ? server.resourceUrl(value) ?? value : value
  for (const element of [HTMLImageElement, HTMLSourceElement]) {
    const descriptor = Object.getOwnPropertyDescriptor(element.prototype, 'src')
    if (!descriptor?.set || !descriptor.get) continue
    Object.defineProperty(element.prototype, 'src', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get!.call(this) },
      set(value) { descriptor.set!.call(this, rewrite(value)) },
    })
  }
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (name === 'src' && (this instanceof HTMLImageElement || this instanceof HTMLSourceElement)) value = rewrite(value) as string
    return setAttribute.call(this, name, value)
  }

  // Failed write actions would otherwise surface as blocking alerts.
  window.alert = () => showReadOnlyNotice()
  return server
}

// The demo shows one recorded moment: running durations, relative times and
// "waiting since" labels read as if the page were opened right after recording.
export function installClock(recordedAt: number) {
  if (!Number.isFinite(recordedAt)) return
  const RealDate = Date
  const offset = recordedAt - RealDate.now()
  class DemoDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...(args as [any]))
    }
    static now() { return RealDate.now() + offset }
  }
  window.Date = DemoDate as DateConstructor
}

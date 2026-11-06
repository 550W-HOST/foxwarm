import { createRef, useEffect, useRef } from 'react'
import { useDndContext } from '@dnd-kit/core'
import { CODE_BRIDGE_CHANNEL, CODE_BRIDGE_VERSION, type CodeOpenRequest } from '../vscodeWeb'

type PendingRequest = {
  request: CodeOpenRequest
  sent: boolean
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: number
}

export function createCodeFrame(src: string) {
  const iframeRef = createRef<HTMLIFrameElement>()
  const pending = new Map<string, PendingRequest>()
  let ready = false
  let sequence = 0
  const flush = () => {
    const target = iframeRef.current?.contentWindow
    if (!ready || !target) return
    for (const [requestId, entry] of pending) {
      if (entry.sent) continue
      entry.sent = true
      target.postMessage({ channel: CODE_BRIDGE_CHANNEL, version: CODE_BRIDGE_VERSION, type: 'request', requestId, request: entry.request }, window.location.origin)
    }
  }
  return {
    src,
    started: false,
    iframeRef,
    request(request: CodeOpenRequest): Promise<unknown> {
      const requestId = `code-${++sequence}`
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('Code did not respond to the open request.'))
        }, 30_000)
        pending.set(requestId, { request, sent: false, resolve, reject, timer })
        flush()
      })
    },
    receive(event: MessageEvent, open: (request: CodeOpenRequest) => void) {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return
      const message = event.data
      if (!message || message.channel !== CODE_BRIDGE_CHANNEL || message.version !== CODE_BRIDGE_VERSION) return
      if (message.type === 'open' && message.request?.kind === 'openManagedRoot'
        && message.request.nodeId === 'master' && (message.request.root === 'app' || message.request.root === 'data')
        && typeof message.request.path === 'string' && message.request.path.startsWith('/')) {
        open(message.request)
      } else if (message.type === 'ready') {
        ready = true
        flush()
      } else if (message.type === 'response' && typeof message.requestId === 'string') {
        const entry = pending.get(message.requestId)
        if (!entry) return
        pending.delete(message.requestId)
        window.clearTimeout(entry.timer)
        if (message.ok === true) entry.resolve(message.result)
        else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'Code open request failed.'))
      }
    },
    onLoad() {
      ready = false
      for (const entry of pending.values()) entry.sent = false
    },
    dispose() {
      ready = false
      for (const entry of pending.values()) {
        window.clearTimeout(entry.timer)
        entry.reject(new DOMException('Code frame was closed before the open request completed.', 'AbortError'))
      }
      pending.clear()
    },
  }
}

export type CodeFrame = ReturnType<typeof createCodeFrame>

// Controllers exist before first-visible iframe admission so initial requests can queue.
export function useCodeFrames(open: (request: CodeOpenRequest) => void) {
  const openRef = useRef(open)
  openRef.current = open
  const frames = useRef(new Map<string, CodeFrame>()).current
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      for (const frame of frames.values()) frame.receive(event, request => openRef.current(request))
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      for (const frame of frames.values()) frame.dispose()
    }
  }, [frames])
  return frames
}

export default function VscodeWebFrameHost({ frame, nodeId }: { frame: CodeFrame; nodeId: string }) {
  const { active } = useDndContext()
  return (
    <iframe
      ref={frame.iframeRef}
      src={frame.src}
      title={`Code · ${nodeId}`}
      allow="clipboard-read; clipboard-write"
      className="relative h-full w-full border-0 bg-fw-canvas-edge"
      style={{ zIndex: 35, pointerEvents: active ? 'none' : undefined }}
      onLoad={frame.onLoad}
      data-foxwarm-vscode-web-frame="true"
      data-code-node={nodeId}
    />
  )
}

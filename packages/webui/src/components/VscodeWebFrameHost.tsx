import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { useDndContext } from '@dnd-kit/core'
import { CODE_BRIDGE_CHANNEL, CODE_BRIDGE_VERSION, type CodeOpenRequest } from '../vscodeWeb'

interface VscodeWebFrameBridgeOptions {
  started: boolean
  src: string
}

export interface VscodeWebFrameHostHandle {
  request: (request: CodeOpenRequest) => Promise<unknown>
}

type PendingRequest = {
  requestId: string
  request: CodeOpenRequest
  sent: boolean
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: number
}

const BRIDGE_TIMEOUT_MS = 30_000

export function useVscodeWebFrameBridge({ started, src }: VscodeWebFrameBridgeOptions, ref: Ref<VscodeWebFrameHostHandle>) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const bridgeReadyRef = useRef(false)
  const pendingRef = useRef(new Map<string, PendingRequest>())
  const nextRequestIdRef = useRef(0)

  const flushRequests = () => {
    const iframeWindow = iframeRef.current?.contentWindow
    if (!bridgeReadyRef.current || !iframeWindow) return
    for (const pending of pendingRef.current.values()) {
      if (pending.sent) continue
      pending.sent = true
      iframeWindow.postMessage({
        channel: CODE_BRIDGE_CHANNEL,
        version: CODE_BRIDGE_VERSION,
        type: 'request',
        requestId: pending.requestId,
        request: pending.request,
      }, window.location.origin)
    }
  }

  useImperativeHandle(ref, () => ({
    request(request) {
      const requestId = `code-${Date.now()}-${++nextRequestIdRef.current}`
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingRef.current.delete(requestId)
          reject(new Error('Code did not respond to the open request.'))
        }, BRIDGE_TIMEOUT_MS)
        pendingRef.current.set(requestId, {
          requestId,
          request,
          sent: false,
          resolve,
          reject,
          timer,
        })
        flushRequests()
      })
    },
  }))

  useLayoutEffect(() => {
    bridgeReadyRef.current = false
    for (const pending of pendingRef.current.values()) pending.sent = false
  }, [src])

  useLayoutEffect(() => {
    if (started) return
    bridgeReadyRef.current = false
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('Code frame was closed before the open request completed.'))
    }
    pendingRef.current.clear()
  }, [started])

  useEffect(() => {
    const handleBridgeMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return
      const message = event.data
      if (!message || typeof message !== 'object'
        || message.channel !== CODE_BRIDGE_CHANNEL
        || message.version !== CODE_BRIDGE_VERSION) return

      if (message.type === 'ready') {
        bridgeReadyRef.current = true
        flushRequests()
        return
      }
      if (message.type !== 'response' || typeof message.requestId !== 'string') return

      const pending = pendingRef.current.get(message.requestId)
      if (!pending) return
      pendingRef.current.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Code open request failed.'))
    }

    window.addEventListener('message', handleBridgeMessage)
    return () => window.removeEventListener('message', handleBridgeMessage)
  }, [])

  useEffect(() => () => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('Code frame was closed before the open request completed.'))
    }
    pendingRef.current.clear()
  }, [])

  return {
    iframeRef,
    onLoad: () => {
      bridgeReadyRef.current = false
      for (const pending of pendingRef.current.values()) pending.sent = false
    },
  }
}

export default function VscodeWebFrameHost({ src, bridge }: { src: string; bridge: ReturnType<typeof useVscodeWebFrameBridge> }) {
  const { active } = useDndContext()
  return (
    <iframe
      ref={bridge.iframeRef}
      src={src}
      title="Code"
      allow="clipboard-read; clipboard-write"
      className="relative h-full w-full border-0 bg-fw-canvas-edge"
      style={{ zIndex: 35, pointerEvents: active ? 'none' : undefined }}
      onLoad={bridge.onLoad}
      data-foxwarm-vscode-web-frame="true"
    />
  )
}

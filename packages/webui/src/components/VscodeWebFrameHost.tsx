import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CODE_BRIDGE_CHANNEL, CODE_BRIDGE_VERSION, type CodeOpenRequest } from '../vscodeWeb'

interface VscodeWebFrameHostProps {
  started: boolean
  src: string
  slot: HTMLElement | null
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

const VscodeWebFrameHost = forwardRef<VscodeWebFrameHostHandle, VscodeWebFrameHostProps>(function VscodeWebFrameHost({ started, src, slot }, ref) {
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

  useLayoutEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    let frame = 0
    let wasVisible = false
    const updatePosition = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const currentIframe = iframeRef.current
        if (!currentIframe) return

        if (!slot?.isConnected) {
          currentIframe.style.visibility = 'hidden'
          currentIframe.style.pointerEvents = 'none'
          wasVisible = false
          return
        }

        const rect = slot.getBoundingClientRect()
        const visible = rect.width > 0 && rect.height > 0
        currentIframe.style.left = `${Math.max(0, rect.left)}px`
        currentIframe.style.top = `${Math.max(0, rect.top)}px`
        currentIframe.style.width = `${Math.max(0, rect.width)}px`
        currentIframe.style.height = `${Math.max(0, rect.height)}px`
        currentIframe.style.visibility = visible ? 'visible' : 'hidden'
        currentIframe.style.pointerEvents = visible ? 'auto' : 'none'

        if (visible && !wasVisible) {
          try {
            currentIframe.contentWindow?.dispatchEvent(new Event('resize'))
          } catch {
            // Same-origin in production; ignore if a development proxy changes origin.
          }
        }
        wasVisible = visible
      })
    }

    const observer = slot ? new ResizeObserver(updatePosition) : null
    if (slot) observer?.observe(slot)
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    updatePosition()

    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [slot])

  if (!started) return null

  return createPortal(
    <iframe
      ref={iframeRef}
      src={src}
      title="Code"
      allow="clipboard-read; clipboard-write"
      className="fixed border-0 bg-fw-canvas-edge"
      style={{ zIndex: 35, visibility: 'hidden', pointerEvents: 'none' }}
      onLoad={() => {
        bridgeReadyRef.current = false
        for (const pending of pendingRef.current.values()) pending.sent = false
      }}
      data-foxwarm-vscode-web-frame="true"
    />,
    document.body,
  )
})

export default VscodeWebFrameHost

import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface VscodeWebFrameHostProps {
  started: boolean
  src: string
  slot: HTMLElement | null
}

export default function VscodeWebFrameHost({ started, src, slot }: VscodeWebFrameHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

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
      className="fixed border-0 bg-gray-950"
      style={{ zIndex: 35, visibility: 'hidden', pointerEvents: 'none' }}
      data-foxwarm-vscode-web-frame="true"
    />,
    document.body,
  )
}

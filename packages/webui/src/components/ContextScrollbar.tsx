import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CHAT_MESSAGE_ANCHOR_SELECTOR } from '../chatViewportState'
import {
  buildContextScrollbarSegments,
  findContextScrollbarSegmentAt,
  getContextScrollbarContextUsage,
  interpolateContextScrollbarBoundary,
  type ContextScrollbarSegment,
} from './contextScrollbarModel'
import type { Message } from './chatShared'

type ContextScrollbarProps = {
  messages: Message[]
  contextLimit: number | null | undefined
  containerRef: RefObject<HTMLDivElement>
  timelineRef: RefObject<HTMLDivElement>
  onNavigate: (anchorKey: string, fraction: number) => void
}

type ViewportRange = { top: number; bottom: number } | null

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

const getBoundaryToken = (segments: ContextScrollbarSegment[], timeline: HTMLElement, viewportY: number): number | null => {
  const anchors = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR))
  const anchor = anchors.find(element => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > viewportY
  }) || anchors[anchors.length - 1]
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  const key = anchor.getAttribute('data-chat-message-anchor-key')
  if (!key || rect.height <= 0) return null
  return interpolateContextScrollbarBoundary(segments, key, clamp((viewportY - rect.top) / rect.height))
}

/**
 * Desktop context overview.  It deliberately reads the native scroll geometry
 * and asks Chat to perform scrolling; it never becomes a scroll container.
 */
const ContextScrollbar = memo(function ContextScrollbar({ messages, contextLimit, containerRef, timelineRef, onNavigate }: ContextScrollbarProps) {
  const segments = useMemo(() => buildContextScrollbarSegments(messages), [messages])
  const contextUsage = useMemo(() => getContextScrollbarContextUsage(messages, contextLimit), [contextLimit, messages])
  const totalEstimatedTokens = segments[segments.length - 1]?.endTokens || 0
  const [viewportRange, setViewportRange] = useState<ViewportRange>(null)
  const frameRef = useRef<number | null>(null)
  const draggingRef = useRef(false)

  const updateViewportRange = useCallback(() => {
    const container = containerRef.current
    const timeline = timelineRef.current
    if (!container || !timeline || !contextUsage || totalEstimatedTokens <= 0) {
      setViewportRange(null)
      return
    }
    const viewport = container.getBoundingClientRect()
    const topToken = getBoundaryToken(segments, timeline, viewport.top)
    const bottomToken = getBoundaryToken(segments, timeline, viewport.bottom)
    if (topToken === null || bottomToken === null) {
      setViewportRange(null)
      return
    }
    const usedFraction = contextUsage.usedTokens / contextUsage.capacityTokens
    setViewportRange({
      top: clamp((topToken / totalEstimatedTokens) * usedFraction),
      bottom: clamp((bottomToken / totalEstimatedTokens) * usedFraction),
    })
  }, [containerRef, contextUsage, segments, timelineRef, totalEstimatedTokens])

  const scheduleViewportUpdate = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      updateViewportRange()
    })
  }, [updateViewportRange])

  useEffect(() => {
    const container = containerRef.current
    const timeline = timelineRef.current
    if (!container || !timeline) return
    const observer = new ResizeObserver(scheduleViewportUpdate)
    observer.observe(timeline)
    observer.observe(container)
    container.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
    window.addEventListener('resize', scheduleViewportUpdate)
    scheduleViewportUpdate()
    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', scheduleViewportUpdate)
      window.removeEventListener('resize', scheduleViewportUpdate)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [containerRef, scheduleViewportUpdate, timelineRef])

  const navigateAtClientY = useCallback((clientY: number, element: HTMLElement) => {
    if (!contextUsage || totalEstimatedTokens <= 0) return
    const rect = element.getBoundingClientRect()
    const fraction = clamp((clientY - rect.top) / Math.max(1, rect.height))
    const usedFraction = contextUsage.usedTokens / contextUsage.capacityTokens
    const estimatedPosition = usedFraction <= 0
      ? totalEstimatedTokens
      : clamp(fraction / usedFraction) * totalEstimatedTokens
    const segment = findContextScrollbarSegmentAt(segments, estimatedPosition)
    if (!segment?.anchorKey) return
    const matching = segments.filter(candidate => candidate.anchorKey === segment.anchorKey)
    const start = matching[0]?.startTokens ?? segment.startTokens
    const end = matching[matching.length - 1]?.endTokens ?? segment.endTokens
    onNavigate(segment.anchorKey, end > start ? (estimatedPosition - start) / (end - start) : 0)
  }, [contextUsage, onNavigate, segments, totalEstimatedTokens])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    navigateAtClientY(event.clientY, event.currentTarget)
  }, [navigateAtClientY])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) navigateAtClientY(event.clientY, event.currentTarget)
  }, [navigateAtClientY])

  const stopDragging = useCallback(() => {
    draggingRef.current = false
  }, [])

  if (!contextUsage || totalEstimatedTokens <= 0) return null

  const usedFraction = clamp(contextUsage.usedTokens / contextUsage.capacityTokens)
  const viewportTop = viewportRange?.top ?? 0
  const viewportBottom = Math.max(viewportTop + 0.008, viewportRange?.bottom ?? 0)

  return (
    <div className="foxwarm-context-scrollbar-shell" aria-label="Context overview">
      <div
        className="foxwarm-context-scrollbar"
        role="scrollbar"
        tabIndex={0}
        aria-label="Context overview scrollbar"
        aria-controls="foxwarm-chat-messages"
        aria-valuemin={0}
        aria-valuemax={contextUsage.capacityTokens}
        aria-valuenow={Math.min(contextUsage.capacityTokens, Math.round((viewportTop / Math.max(usedFraction, 0.0001)) * totalEstimatedTokens))}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onKeyDown={(event) => {
          if (event.key === 'Home') navigateAtClientY(event.currentTarget.getBoundingClientRect().top, event.currentTarget)
          if (event.key === 'End') navigateAtClientY(event.currentTarget.getBoundingClientRect().bottom, event.currentTarget)
        }}
      >
        <div className="foxwarm-context-scrollbar-used" style={{ height: `${usedFraction * 100}%` }}>
          {segments.map(segment => {
            if (segment.estimatedTokens <= 0) return null
            const height = totalEstimatedTokens > 0 ? (segment.estimatedTokens / totalEstimatedTokens) * 100 : 0
            return <div key={segment.key} className={`foxwarm-context-scrollbar-segment foxwarm-context-scrollbar-tone-${segment.tone}`} style={{ height: `${height}%` }} />
          })}
        </div>
        <div className="foxwarm-context-scrollbar-free" style={{ top: `${usedFraction * 100}%` }} />
        {viewportRange && <div className="foxwarm-context-scrollbar-viewport" style={{ top: `${viewportTop * 100}%`, height: `${(viewportBottom - viewportTop) * 100}%` }} />}
      </div>
    </div>
  )
})

export default ContextScrollbar

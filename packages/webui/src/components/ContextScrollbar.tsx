import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Check } from 'lucide-react'
import { CHAT_MESSAGE_ANCHOR_SELECTOR } from '../chatViewportState'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import {
  buildContextScrollbarSegments,
  buildContextScrollbarScaleSegments,
  findContextScrollbarSegmentAt,
  getContextScrollbarContextUsage,
  getContextScrollbarLegendStats,
  interpolateContextScrollbarBoundary,
  type ContextScrollbarSegment,
  type ContextScrollbarVerticalScale,
} from './contextScrollbarModel'
import type { Message } from './chatShared'

type ContextScrollbarProps = {
  messages: Message[]
  persistentMemorySnapshot?: Message | null
  contextLimit: number | null | undefined
  containerId: string
  containerRef: RefObject<HTMLDivElement>
  timelineRef: RefObject<HTMLDivElement>
  onNavigate: (anchorKey: string, fraction: number) => void
}

type ViewportRange = { top: number; bottom: number } | null
type TimelineAnchorGeometry = { key: string; top: number; bottom: number }

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const formatTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(value)
const legendLabels = {
  snapshot: 'system prompt snapshot',
  system: 'system events',
  tools: 'tool calls',
  user: 'user prompts',
  reasoning: 'model reasoning',
  model: 'model contents',
} as const
const verticalScaleLabels: Record<ContextScrollbarVerticalScale, string> = {
  tokens: 'Token count',
  'tokens-logarithmic': 'Token count (logarithmic)',
  'rendered-height': 'Rendered height',
}
const VERTICAL_SCALE_STORAGE_KEY = 'foxwarm.contextScrollbar.verticalScale'

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
const ContextScrollbar = memo(function ContextScrollbar({ messages, persistentMemorySnapshot, contextLimit, containerId, containerRef, timelineRef, onNavigate }: ContextScrollbarProps) {
  const rawSegments = useMemo(() => buildContextScrollbarSegments(messages, persistentMemorySnapshot), [messages, persistentMemorySnapshot])
  const [verticalScale, setVerticalScale] = useState<ContextScrollbarVerticalScale>(() => {
    const value = window.localStorage.getItem(VERTICAL_SCALE_STORAGE_KEY)
    return value === 'tokens-logarithmic' || value === 'rendered-height' ? value : 'tokens'
  })
  const [measuredAnchorHeights, setMeasuredAnchorHeights] = useState<Record<string, number>>({})
  const [scaleMenu, setScaleMenu] = useState<{ x: number; y: number } | null>(null)
  const segments = useMemo(() => buildContextScrollbarScaleSegments(rawSegments, verticalScale, measuredAnchorHeights), [measuredAnchorHeights, rawSegments, verticalScale])
  const legendStats = useMemo(() => getContextScrollbarLegendStats(rawSegments), [rawSegments])
  const contextUsage = useMemo(() => getContextScrollbarContextUsage(messages, contextLimit), [contextLimit, messages])
  const effectiveContextUsage = verticalScale === 'rendered-height' ? null : contextUsage
  const totalEstimatedTokens = segments[segments.length - 1]?.endTokens || 0
  const [viewportRange, setViewportRange] = useState<ViewportRange>(null)
  const frameRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const dragThumbFractionRef = useRef(0.5)

  const selectVerticalScale = useCallback((next: ContextScrollbarVerticalScale) => {
    window.localStorage.setItem(VERTICAL_SCALE_STORAGE_KEY, next)
    setVerticalScale(next)
    setScaleMenu(null)
  }, [])
  const scaleMenuEntries = useMemo<ContextMenuEntry[]>(() => (Object.keys(verticalScaleLabels) as ContextScrollbarVerticalScale[]).map(scale => ({
    key: scale,
    label: verticalScaleLabels[scale],
    icon: verticalScale === scale ? <Check size={14} /> : null,
    checked: verticalScale === scale,
    onSelect: () => selectVerticalScale(scale),
  })), [selectVerticalScale, verticalScale])

  const updateViewportRange = useCallback(() => {
    const container = containerRef.current
    const timeline = timelineRef.current
    if (!container || !timeline || totalEstimatedTokens <= 0) {
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
    const usedFraction = effectiveContextUsage ? effectiveContextUsage.usedTokens / effectiveContextUsage.capacityTokens : 1
    const timelineAnchors = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR))
    const nextMeasuredHeights = timelineAnchors.reduce<Record<string, number>>((heights, anchor) => {
      const key = anchor.getAttribute('data-chat-message-anchor-key')
      const height = anchor.getBoundingClientRect().height
      if (key && height > 0) heights[key] = height
      return heights
    }, {})
    setMeasuredAnchorHeights(current => {
      const keys = Object.keys(nextMeasuredHeights)
      return keys.length === Object.keys(current).length && keys.every(key => Math.abs((current[key] || 0) - nextMeasuredHeights[key]) < 0.5) ? current : nextMeasuredHeights
    })
    const lastAnchor = timelineAnchors[timelineAnchors.length - 1]
    const toCommittedPosition = (token: number) => clamp((token / totalEstimatedTokens) * usedFraction)
    let topPosition = toCommittedPosition(topToken)
    let bottomPosition = toCommittedPosition(bottomToken)
    if (effectiveContextUsage && lastAnchor) {
      const lastRect = lastAnchor.getBoundingClientRect()
      const lastStartToken = interpolateContextScrollbarBoundary(segments, lastAnchor.getAttribute('data-chat-message-anchor-key') || '', 0) ?? totalEstimatedTokens
      const finalRowDensity = Math.max(0, usedFraction - toCommittedPosition(lastStartToken)) / Math.max(1, lastRect.height)
      if (viewport.top > lastRect.bottom) {
        topPosition = clamp(usedFraction + (viewport.top - lastRect.bottom) * finalRowDensity)
      }
      if (viewport.bottom > lastRect.bottom) {
        // Extrapolate only the message density already framed by this
        // viewport. Trailing composer/blank layout must not imply that all
        // provider free context is visible at native scroll end.
        const framedHeight = Math.max(1, lastRect.bottom - viewport.top)
        const framedDensity = viewport.top < lastRect.bottom
          ? Math.max(0, usedFraction - topPosition) / framedHeight
          : finalRowDensity
        bottomPosition = clamp(usedFraction + (viewport.bottom - lastRect.bottom) * framedDensity)
      }
    }
    setViewportRange({
      top: topPosition,
      bottom: Math.max(topPosition, bottomPosition),
    })
  }, [containerRef, effectiveContextUsage, segments, timelineRef, totalEstimatedTokens])

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
    if (totalEstimatedTokens <= 0) return
    const rect = element.getBoundingClientRect()
    const fraction = clamp((clientY - rect.top) / Math.max(1, rect.height))
    const usedFraction = effectiveContextUsage ? effectiveContextUsage.usedTokens / effectiveContextUsage.capacityTokens : 1
    const estimatedPosition = usedFraction <= 0
      ? totalEstimatedTokens
      : clamp(fraction / usedFraction) * totalEstimatedTokens
    const segment = findContextScrollbarSegmentAt(segments, estimatedPosition)
    if (!segment) return
    const anchorKey = segment.anchorKey
    if (!anchorKey) return
    const matching = segments.filter(candidate => candidate.anchorKey === anchorKey)
    const start = matching[0]?.startTokens ?? segment.startTokens
    const end = matching[matching.length - 1]?.endTokens ?? segment.endTokens
    onNavigate(anchorKey, segment.category === 'snapshot' ? 0 : (end > start ? (estimatedPosition - start) / (end - start) : 0))
  }, [effectiveContextUsage, onNavigate, segments, totalEstimatedTokens])

  const navigateToViewportTarget = useCallback((fraction: number, thumbFraction: number, element: HTMLElement) => {
    const container = containerRef.current
    const timeline = timelineRef.current
    const usedFraction = effectiveContextUsage ? effectiveContextUsage.usedTokens / effectiveContextUsage.capacityTokens : 1
    const targetToken = usedFraction <= 0 ? totalEstimatedTokens : clamp(fraction / usedFraction) * totalEstimatedTokens
    if (!container || !timeline || totalEstimatedTokens <= 0) {
      navigateAtClientY(element.getBoundingClientRect().top + clamp(fraction) * element.clientHeight, element)
      return
    }

    const containerRect = container.getBoundingClientRect()
    const anchors: TimelineAnchorGeometry[] = Array.from(timeline.querySelectorAll<HTMLElement>(CHAT_MESSAGE_ANCHOR_SELECTOR))
      .map(anchor => {
        const key = anchor.getAttribute('data-chat-message-anchor-key')
        const rect = anchor.getBoundingClientRect()
        return key && rect.height > 0
          ? { key, top: rect.top - containerRect.top + container.scrollTop, bottom: rect.bottom - containerRect.top + container.scrollTop }
          : null
      })
      .filter((anchor): anchor is TimelineAnchorGeometry => anchor !== null)
    const measuredKeys = new Set(anchors.map(anchor => anchor.key))
    const fullyMeasured = segments.every(segment => !segment.anchorKey || measuredKeys.has(segment.anchorKey))
    if (!fullyMeasured) {
      // The requested target will cause Chat to expand its lazy timeline when
      // needed. Once rows exist, later direct gestures use the exact mapping.
      const viewportHeight = (viewportRange?.bottom ?? 0) - (viewportRange?.top ?? 0)
      const topFraction = fraction - thumbFraction * viewportHeight
      navigateAtClientY(element.getBoundingClientRect().top + clamp(topFraction) * element.clientHeight, element)
      return
    }

    const tokenAtScrollTop = (scrollTop: number): number => {
      const contentY = scrollTop
      const anchor = anchors.find(candidate => candidate.bottom > contentY) || anchors[anchors.length - 1]
      if (!anchor) return 0
      const token = interpolateContextScrollbarBoundary(segments, anchor.key, clamp((contentY - anchor.top) / Math.max(1, anchor.bottom - anchor.top)))
      return token ?? 0
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    let low = 0
    let high = maxScrollTop
    // This is a pure DOM/token calculation: it samples the piecewise-linear
    // mapping before one native scroll, never scrolls repeatedly to converge.
    for (let iteration = 0; iteration < 22; iteration += 1) {
      const middle = (low + high) / 2
      const topToken = tokenAtScrollTop(middle)
      const bottomToken = tokenAtScrollTop(Math.min(maxScrollTop, middle + container.clientHeight))
      const value = topToken + thumbFraction * (bottomToken - topToken)
      if (value < targetToken) low = middle
      else high = middle
    }
    const targetScrollTop = (low + high) / 2
    const targetAnchor = anchors.find(anchor => anchor.bottom > targetScrollTop) || anchors[anchors.length - 1]
    if (!targetAnchor) return
    onNavigate(targetAnchor.key, clamp((targetScrollTop - targetAnchor.top) / Math.max(1, targetAnchor.bottom - targetAnchor.top)))
  }, [containerRef, effectiveContextUsage, navigateAtClientY, onNavigate, segments, timelineRef, totalEstimatedTokens, viewportRange])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const position = clamp((event.clientY - rect.top) / Math.max(1, rect.height))
    const insideViewport = viewportRange !== null && position >= viewportRange.top && position <= viewportRange.bottom
    draggingRef.current = true
    dragThumbFractionRef.current = insideViewport
      ? clamp((position - viewportRange.top) / Math.max(0.0001, viewportRange.bottom - viewportRange.top))
      : 0.5
    event.currentTarget.setPointerCapture(event.pointerId)
    if (!insideViewport) {
      navigateToViewportTarget(position, 0.5, event.currentTarget)
    }
  }, [navigateToViewportTarget, viewportRange])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      const rect = event.currentTarget.getBoundingClientRect()
      navigateToViewportTarget((event.clientY - rect.top) / Math.max(1, rect.height), dragThumbFractionRef.current, event.currentTarget)
    }
  }, [navigateToViewportTarget])

  const stopDragging = useCallback(() => {
    draggingRef.current = false
    dragThumbFractionRef.current = 0.5
  }, [])

  const usedFraction = effectiveContextUsage ? clamp(effectiveContextUsage.usedTokens / effectiveContextUsage.capacityTokens) : 1
  const viewportTop = viewportRange?.top ?? 0
  const viewportBottom = viewportRange?.bottom ?? viewportTop

  return (
    <div className="foxwarm-context-scrollbar-shell" aria-label="Context overview" onContextMenu={(event) => { event.preventDefault(); setScaleMenu({ x: event.clientX, y: event.clientY }) }}>
      <div
        className="foxwarm-context-scrollbar"
        draggable={false}
        role="scrollbar"
        tabIndex={0}
        aria-label="Context overview scrollbar"
        aria-controls={containerId}
        aria-valuemin={0}
        aria-valuemax={effectiveContextUsage?.capacityTokens ?? totalEstimatedTokens}
        aria-valuenow={Math.min(effectiveContextUsage?.capacityTokens ?? totalEstimatedTokens, Math.round((viewportTop / Math.max(usedFraction, 0.0001)) * totalEstimatedTokens))}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
          handlePointerDown(event)
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onDragStart={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Home') navigateAtClientY(event.currentTarget.getBoundingClientRect().top, event.currentTarget)
          if (event.key === 'End') navigateAtClientY(event.currentTarget.getBoundingClientRect().bottom, event.currentTarget)
        }}
      >
        <div className="foxwarm-context-scrollbar-used" data-context-usage={effectiveContextUsage ? 'measured' : 'unknown'} style={{ height: `${usedFraction * 100}%` }}>
          {segments.map(segment => {
            if (segment.estimatedTokens <= 0) return null
            const height = totalEstimatedTokens > 0 ? (segment.estimatedTokens / totalEstimatedTokens) * 100 : 0
            return <div key={segment.key} data-context-category={segment.category} className={`foxwarm-context-scrollbar-segment foxwarm-context-scrollbar-tone-${segment.tone}${segment.category === 'model' ? ' foxwarm-context-scrollbar-segment-model-content' : ''}`} style={{ height: `${height}%` }} />
          })}
        </div>
        {effectiveContextUsage && <div className="foxwarm-context-scrollbar-free" style={{ top: `${usedFraction * 100}%` }} />}
        {viewportRange && (
          <div className="foxwarm-context-scrollbar-viewport" style={{ top: `${viewportTop * 100}%`, height: `${(viewportBottom - viewportTop) * 100}%` }} />
        )}
      </div>
      <ContextMenu open={scaleMenu !== null} point={scaleMenu} entries={scaleMenuEntries} onClose={() => setScaleMenu(null)} />
      <div className="foxwarm-context-scrollbar-info">
        <button
          type="button"
          draggable={false}
          className="foxwarm-context-scrollbar-info-button"
          aria-label="Context overview legend"
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
          onClick={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
        >
          i
        </button>
        <div className="foxwarm-context-scrollbar-tooltip" role="tooltip">
          {legendStats.map(stat => (
            <div key={stat.category} className="foxwarm-context-scrollbar-legend-row">
              <span className={`foxwarm-context-scrollbar-legend-swatch foxwarm-context-scrollbar-category-${stat.category}`} />
              <span className="foxwarm-context-scrollbar-legend-label">{legendLabels[stat.category]}</span>
              <span className="foxwarm-context-scrollbar-legend-value">{formatTokens(stat.estimatedTokens)} · {stat.percentage.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})

export default ContextScrollbar

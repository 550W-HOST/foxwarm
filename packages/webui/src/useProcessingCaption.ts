import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TimelineView } from './chatPreferences'
import type { RuntimeStatusView } from './runtimeStatus'
import type { SessionRuntimeState } from './sessionRuntimeState'
import { getStreamingCaptions, type StreamingAssistantDraft, type StreamingCaption } from './streamingAssistantDraft'

interface CaptionState {
  request?: string
  attempt?: number
  latest?: StreamingCaption
  shown?: StreamingCaption
  until: number
}
const empty: CaptionState = { until: 0 }
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Caption ownership is request-local; only a displayed tool's minimum can cross requests. */
export function useProcessingCaption(view: RuntimeStatusView | null, runtime: SessionRuntimeState | undefined,
  draft: StreamingAssistantDraft | null | undefined, mode: TimelineView | undefined): string | undefined {
  const previous = useRef<CaptionState>(empty)
  const [, tick] = useState(0)
  const now = Date.now()
  let next = empty
  if (view?.playful || view?.kind === 'tool') {
    // The final commit clears the draft before the runtime leaves this model attempt; keep its caption until then.
    const attempt = view.playful ? runtime?.since : undefined
    const retained = view.playful && !draft && attempt !== undefined && previous.current.attempt === attempt ? previous.current.request : undefined
    const request = view.playful ? runtime?.active?.streamId || draft?.streamId || retained : undefined
    const matchesRequest = !draft || draft.streamId === request
    let latest = matchesRequest && request && previous.current.request === request ? previous.current.latest : undefined
    if (view.playful && draft && request === draft.streamId) {
      const candidate = getStreamingCaptions(draft).filter(item => mode === 'conversation' || item.kind === 'tool').at(-1)
      if (candidate && (!latest || candidate.order >= latest.order)) latest = candidate
    }
    if (mode !== 'conversation' && latest?.kind === 'reasoning') latest = undefined
    const tool = runtime?.tool
    const name = tool?.name.split(/[.:/]/).at(-1)
    if (view.kind === 'tool' && tool?.source !== 'mcp' && (name === 'exec' || name === 'run_script') && tool?.argsPreview?.trim()) {
      const key = tool.id || `execution:${tool.startedAt}:${tool.name}`
      // The runtime preview is shortened. Keep the already-visible complete summary at the same call's handoff.
      latest = previous.current.shown?.kind === 'tool' && previous.current.shown.key === key
        ? previous.current.shown
        : { kind: 'tool', key, text: tool.argsPreview.trim(), order: -1 }
    }
    const held = previous.current.shown?.kind === 'tool' && previous.current.until > now
    const shown = held ? previous.current.shown : latest
    const until = shown?.kind === 'tool'
      ? shown.key === previous.current.shown?.key ? previous.current.until : now + 3000
      : 0
    next = { request, attempt, latest, shown, until }
  }
  useBrowserLayoutEffect(() => { previous.current = next })
  const deadline = next.until
  useEffect(() => {
    if (deadline <= Date.now()) return
    const timer = window.setTimeout(() => tick(value => value + 1), deadline - Date.now())
    return () => window.clearTimeout(timer)
  }, [deadline])
  return next.shown?.text
}

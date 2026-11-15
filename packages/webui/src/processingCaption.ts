import type { TimelineView } from './chatPreferences'
import { isCommittedHistoryMessage } from './chatHistoryState'
import { isInternalTimelineMessage, type Message } from './components/chatShared'
import { extractOpenAIReasoningSummaryTitles } from './reasoningSummary'
import type { SessionRuntimeState } from './sessionRuntimeState'
import { getStreamingCaptions, type StreamingAssistantDraft, type StreamingCaption } from './streamingAssistantDraft'
import { getStreamingToolSummary } from './streamingToolSummary'
import { isCompactCompletionMaintenanceMessage, isTaskReminderMessage } from '../../shared/src/sessionContinuation'

/** One displayable or position-only item; tool calls without a summary still mark execution progress. */
export type CaptionItem = { kind: StreamingCaption['kind']; text?: string; callId?: string }

/** Committed caption items since the latest input, in history order. */
export interface CaptionSegment {
  items: CaptionItem[]
  /** Timestamp of the input that opened the segment, when it is loaded. */
  since?: number
}

/**
 * Input entering the conversation opens a new caption segment: direct user messages, other Sessions'
 * messages, and delivered event or notification inputs. Model output, tool results, queued previews and
 * runtime bookkeeping (reminders, compaction maintenance, settings and first-run boundaries) do not.
 */
export function isCaptionInputBoundary(message: Message): boolean {
  return message.role === 'user' && isCommittedHistoryMessage(message) && !message.__meta?.queuedPreview
    && !message.__meta?.contextBlock && !isInternalTimelineMessage(message) && !isTaskReminderMessage(message)
    && !isCompactCompletionMaintenanceMessage(message)
    && message.parts.some(part => !part.functionResponse && !part.toolUseId)
}

/** Reads the loaded history after its latest input; summaries before a context block are not live evidence. */
export function getCaptionSegment(history: readonly Message[] | undefined): CaptionSegment {
  let start = 0
  let since: number | undefined
  for (let index = (history?.length ?? 0) - 1; index >= 0; index--) {
    const message = history![index]
    if (message.__meta?.contextBlock) { start = index + 1; break }
    if (isCaptionInputBoundary(message)) {
      start = index + 1
      since = Number.isFinite(message.__meta?.timestamp) ? message.__meta!.timestamp : undefined
      break
    }
  }
  const items: CaptionItem[] = []
  for (const message of history?.slice(start) || []) {
    if (message.role !== 'model' || message.modelVisible === false || !isCommittedHistoryMessage(message)) continue
    for (const part of message.parts) {
      if (typeof part.thinking === 'string') {
        // Same first-line heading gate as the Reasoning card, per committed reasoning item like the live draft.
        const text = extractOpenAIReasoningSummaryTitles(part.thinking).at(-1)
        if (text) items.push({ kind: 'reasoning', text })
      } else if (part.functionCall) {
        const call = part.functionCall
        const text = getStreamingToolSummary({ index: 0, name: call.name,
          arguments: call.argsParseError && typeof call.rawArgsText === 'string' ? call.rawArgsText : JSON.stringify(call.args ?? {}) })
        items.push({ kind: 'tool', ...(text ? { text } : {}), ...(call.id ? { callId: call.id } : {}) })
      }
    }
  }
  return { items, ...(since !== undefined ? { since } : {}) }
}

const runtimeToolSummary = (tool: SessionRuntimeState['tool']): string | undefined => {
  const name = tool?.name.split(/[.:/]/).at(-1)
  return tool && tool.source !== 'mcp' && (name === 'exec' || name === 'run_script') ? tool.argsPreview?.trim() || undefined : undefined
}

/**
 * The last displayable item since the latest input: committed history, then the live draft. A running
 * tool marks the current position, so later calls of its batch wait for their own execution. The
 * shortened runtime preview is used only when history has no summary for that call.
 */
export function selectProcessingCaption(segment: CaptionSegment, draft: StreamingAssistantDraft | null | undefined,
  runtime: SessionRuntimeState | undefined, mode: TimelineView | undefined): string | undefined {
  let items = segment.items
  const tool = runtime?.state === 'running-tool' ? runtime.tool : undefined
  const position = tool?.id ? items.findLastIndex(item => item.callId === tool.id) : -1
  if (position >= 0) {
    items = items.slice(0, position + 1)
    const fallback = runtimeToolSummary(tool)
    if (!items[position].text && fallback) items[position] = { ...items[position], text: fallback }
  } else {
    const current = draft && (!runtime?.active?.streamId || runtime.active.streamId === draft.streamId)
      && !(segment.since !== undefined && draft.startedAt !== undefined && draft.startedAt < segment.since)
    if (current) items = [...items, ...getStreamingCaptions(draft)]
    const fallback = runtimeToolSummary(tool)
    if (fallback) items = [...items, { kind: 'tool', text: fallback }]
  }
  return items.findLast(item => item.text && (mode === 'conversation' || item.kind === 'tool'))?.text
}

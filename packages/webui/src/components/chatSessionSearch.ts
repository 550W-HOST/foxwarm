import type { Message } from './chatShared'
import { formatStructuredSystemText, isSystemLikeText, renderAssistantMarkdownSegments, renderMarkdownSegments } from './chatShared'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { getContextBlockMetaFromMessage, getContextBlockSummaryText } from './ContextBlockCard'
import { getGroupedToolEntries, getToolCallSearchText, getToolResponseSearchText } from './ToolTimelineItems'
import { buildTimelineRows } from './timelineRows'
import { splitCommitMarkers } from '../commitMarker'
import { parsePastedTextSegments } from '../pastedText'
import { findAttachmentCorrelations, getPartDisplayText, stripGeneratedDescriptorLines } from './ChatTimeline'
import { getReasoningText, isReasoningPart } from './reasoningParts'

export type SearchSurface = 'user' | 'pasted' | 'system' | 'model' | 'reasoning' | 'ctx' | 'call' | 'response'
export interface SearchField {
  rowKey: string
  groupKey?: string
  sourceIndex: number
  groupStartIndex?: number
  surface: SearchSurface
  partIndex: number
  toolIndex?: number
  responseIndex?: number
  pastedIndex?: number
  text: string
}
export interface SessionSearchMatch extends SearchField {
  id: string
  offset: number
  ordinal: number
  query: string
}

// Rendered Markdown text, not Markdown syntax or the source of non-text special blocks.
const htmlText = (html: string): string => new DOMParser().parseFromString(html, 'text/html').body.textContent || ''
const markdownText = (text: string, assistant: boolean): string => (
  (assistant ? renderAssistantMarkdownSegments(text) : renderMarkdownSegments(text))
    .map(segment => segment.kind === 'html' ? htmlText(segment.html) : '\u0000')
    .join('\u0000')
)
const assistantText = (text: string): string => splitCommitMarkers(text).map(segment => (
  segment.kind === 'markdown' ? markdownText(segment.text, true) : segment.kind === 'invalid' ? segment.raw : '\u0000'
)).join('\u0000')

// RegExp match.index stays in the original string's UTF-16 offsets even when
// lowercasing an earlier character would have changed its length.
const literalOccurrences = (text: string, query: string): Array<{ offset: number; length: number }> => {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return [...text.matchAll(pattern)].map(match => ({ offset: match.index, length: match[0].length }))
}

/** Only called while Search is open; recompute on committed history changes, not on each keystroke. */
export function projectSessionSearchFields(messages: Message[], groupTools: boolean): SearchField[] {
  const committed: Message[] = []
  const sourceIndices = new Map<Message, number>()
  messages.forEach((message, index) => {
    if (!isCommittedHistoryMessage(message) || message.__meta?.synthetic) return
    committed.push(message)
    sourceIndices.set(message, index)
  })
  const input = { messages: committed, isMobile: false, groupTools, showUsageBadge: false, showTimeDividers: false, nestedDepth: 0, expandedGroupKeys: new Set<string>() }
  const initial = buildTimelineRows(input, null)
  // The normal collapsed render omits whole Event/Goal reminder rows inside groups.
  // Reuse the same row builder in data-only expanded mode so their own row/group keys survive.
  const groupKeys = new Set(initial.rows.filter(row => row.group?.summaryItems.length && !row.group.keepExpanded).map(row => row.group!.key))
  const rows = groupKeys.size
    ? buildTimelineRows({ ...input, expandedGroupKeys: groupKeys }, initial.cache).rows
    : initial.rows
  const groupStarts = new Map<string, number>()
  rows.forEach(row => {
    if (row.group && !groupStarts.has(row.group.key)) groupStarts.set(row.group.key, sourceIndices.get(row.msg)!)
  })
  const fields: SearchField[] = []
  for (const row of rows) {
    const { msg, key: rowKey } = row
    const groupKey = row.group?.key
    const sourceIndex = sourceIndices.get(msg)!
    const add = (surface: SearchSurface, partIndex: number, text: string, toolIndex?: number, responseIndex?: number, pastedIndex?: number) => {
      if (text.trim()) fields.push({ rowKey, groupKey, sourceIndex, groupStartIndex: groupKey ? groupStarts.get(groupKey) : undefined, surface, partIndex, ...(toolIndex !== undefined ? { toolIndex } : {}), ...(responseIndex !== undefined ? { responseIndex } : {}), ...(pastedIndex !== undefined ? { pastedIndex } : {}), text })
    }
    if (row.systemLikeMessage) {
      const body = msg.parts.map(part => part.system ? formatStructuredSystemText(part.system) : part.text || '').filter(Boolean).join('\n')
      add('system', 0, body.split('\n').filter(line => !isSystemLikeText(line)).join('\n'))
      continue
    }
    if (msg.role === 'user') {
      const attachmentCorrelations = findAttachmentCorrelations(msg.parts)
      msg.parts.forEach((part, index) => {
        const text = stripGeneratedDescriptorLines(getPartDisplayText(part), attachmentCorrelations)
        // Pasted content is opaque: metadata-looking tags inside it are literal visible text.
        const segments = parsePastedTextSegments(text).map(segment => segment.kind === 'text'
          ? { kind: 'text' as const, text: segment.text.replace(/<\/?(?:foxwarm-system|foxwarm-message)\b[^>]*>/gi, '') }
          : segment)
        add('user', index, segments.map(segment => segment.kind === 'text'
          ? segment.text.replace(/<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g, (tag, ref: string) => attachmentCorrelations.has(ref) ? '\u0000' : tag)
          : '\u0000').join('\u0000'))
        let pastedIndex = 0
        for (const segment of segments) {
          if (segment.kind === 'pasted-text') add('pasted', index, segment.text, undefined, undefined, pastedIndex++)
        }
      })
      continue
    }
    const ctxIndex = msg.role === 'model' && getContextBlockMetaFromMessage(msg)
      ? msg.parts.findIndex(part => typeof part.text === 'string' && part.text.trim()) : -1
    msg.parts.forEach((part, index) => {
      if (isReasoningPart(part)) add('reasoning', index, markdownText(getReasoningText(part), false))
      if (msg.role === 'model' && part.text) {
        add(index === ctxIndex ? 'ctx' : 'model', index,
          index === ctxIndex ? markdownText(getContextBlockSummaryText(part.text), false) : assistantText(part.text))
      }
    })
    if (row.pairedToolResponse) {
      getGroupedToolEntries(msg, row.pairedToolResponse, rowKey).forEach((entry, toolIndex) => {
        if (entry.call) add('call', toolIndex, getToolCallSearchText(entry.call), toolIndex)
        entry.responses.forEach((response, responseIndex) => add('response', responseIndex, getToolResponseSearchText(response), toolIndex, responseIndex))
      })
    } else {
      msg.parts.flatMap(part => part.functionCall ? [part.functionCall] : []).forEach((call, index) => {
        add('call', index, getToolCallSearchText(call), index)
      })
    }
    if (!row.pairedToolResponse && (msg.role === 'tool' || msg.role === 'model')) {
      msg.parts.flatMap(part => part.functionResponse ? [part.functionResponse] : []).forEach((response, index) => {
        add('response', index, getToolResponseSearchText(response), index, 0)
      })
    }
  }
  return fields
}

export function findSessionSearchMatches(fields: readonly SearchField[], query: string): SessionSearchMatch[] {
  if (!query) return []
  const matches: SessionSearchMatch[] = []
  fields.forEach(field => {
    literalOccurrences(field.text, query).forEach(({ offset }, ordinal) => {
      matches.push({ ...field, id: `${field.rowKey}:${field.surface}:${field.partIndex}:${field.toolIndex ?? ''}:${field.responseIndex ?? ''}:${field.pastedIndex ?? ''}:${offset}`, offset, ordinal, query })
    })
  })
  return matches
}

/** A DOM Range across syntax/Markdown spans, without changing any React-managed text nodes. */
export function findRenderedMatchRange(surface: Element, query: string, ordinal: number): Range | null {
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let joined = ''
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-search-exclude]')) continue
    nodes.push(node as Text)
    joined += node.textContent || ''
  }
  const match = literalOccurrences(joined, query)[ordinal]
  if (!match) return null
  const locate = (position: number, edge: 'start' | 'end'): [Text, number] | null => {
    for (const current of nodes) {
      const length = current.length
      // A start exactly at the boundary belongs to the following included
      // node; otherwise its Range would span excluded DOM between the nodes.
      if (position < length || (edge === 'end' && position === length)) return [current, position]
      position -= length
    }
    return null
  }
  const start = locate(match.offset, 'start')
  const end = locate(match.offset + match.length, 'end')
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...start)
  range.setEnd(...end)
  return range
}

export function findSearchSurface(timeline: Element, match: SessionSearchMatch): Element | null {
  const rows = timeline.querySelectorAll<HTMLElement>('[data-search-row]')
  for (const row of rows) {
    if (row.dataset.searchRow !== match.rowKey) continue
    const cards = match.toolIndex === undefined
      ? [row]
      : [...row.querySelectorAll<HTMLElement>('[data-search-tool-index]')].filter(card => card.dataset.searchToolIndex === String(match.toolIndex))
    for (const card of cards) {
      const surfaces = card.querySelectorAll<HTMLElement>('[data-search-surface]')
      for (const surface of surfaces) {
        if (surface.dataset.searchSurface !== match.surface) continue
        if (match.surface === 'pasted' && surface.dataset.searchPastedIndex !== String(match.pastedIndex)) continue
        if (match.surface === 'response') {
          if (surface.dataset.searchResponseIndex === String(match.responseIndex)) return surface
        } else if (match.surface === 'system' || match.surface === 'call' || surface.dataset.searchPartIndex === String(match.partIndex)) {
          return surface
        }
      }
    }
  }
  return null
}

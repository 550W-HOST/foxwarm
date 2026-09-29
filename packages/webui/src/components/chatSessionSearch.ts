import type { Message } from './chatShared'
import { formatStructuredSystemText, isSystemLikeText, renderAssistantMarkdownSegments, renderMarkdownSegments } from './chatShared'
import { isCommittedHistoryMessage } from '../chatHistoryState'
import { getContextBlockMetaFromMessage, getContextBlockSummaryText } from './ContextBlockCard'
import { getGroupedToolEntries, getToolCallSearchText, getToolResponseSearchText } from './ToolTimelineItems'
import { buildTimelineRows } from './timelineRows'
import { splitCommitMarkers } from '../commitMarker'
import { parsePastedTextSegments } from '../pastedText'
import { findAttachmentCorrelations, getPartDisplayText, stripGeneratedDescriptorLines } from './ChatTimeline'

export type SearchSurface = 'user' | 'pasted' | 'system' | 'model' | 'reasoning' | 'ctx' | 'call' | 'response'
export interface SearchField {
  rowKey: string
  groupKey?: string
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

/** Only called while Search is open; recompute on committed history changes, not on each keystroke. */
export function projectSessionSearchFields(messages: Message[], groupTools: boolean): SearchField[] {
  const committed = messages.filter(message => isCommittedHistoryMessage(message) && !message.__meta?.synthetic)
  const rows = buildTimelineRows({ messages: committed, isMobile: false, groupTools, showUsageBadge: false, showTimeDividers: false, nestedDepth: 0, expandedGroupKeys: new Set() }, null).rows
  const fields: SearchField[] = []
  for (const row of rows) {
    const { msg, key: rowKey } = row
    const groupKey = row.group?.key
    const add = (surface: SearchSurface, partIndex: number, text: string, toolIndex?: number, responseIndex?: number, pastedIndex?: number) => {
      if (text.trim()) fields.push({ rowKey, groupKey, surface, partIndex, ...(toolIndex !== undefined ? { toolIndex } : {}), ...(responseIndex !== undefined ? { responseIndex } : {}), ...(pastedIndex !== undefined ? { pastedIndex } : {}), text })
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
        // Metadata wrappers are not searchable content; their text bodies remain searchable.
        const segments = parsePastedTextSegments(text.replace(/<\/?(?:foxwarm-system|foxwarm-message)\b[^>]*>/gi, ''))
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
      if (part.thinking) add('reasoning', index, markdownText(part.thinking, false))
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
  const loweredQuery = query.toLowerCase()
  const matches: SessionSearchMatch[] = []
  fields.forEach(field => {
    const text = field.text.toLowerCase()
    let from = 0
    let ordinal = 0
    while (from < text.length) {
      const offset = text.indexOf(loweredQuery, from)
      if (offset < 0) break
      matches.push({ ...field, id: `${field.rowKey}:${field.surface}:${field.partIndex}:${field.toolIndex ?? ''}:${field.responseIndex ?? ''}:${field.pastedIndex ?? ''}:${offset}`, offset, ordinal, query })
      ordinal++
      from = offset + Math.max(loweredQuery.length, 1)
    }
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
  const lowered = joined.toLowerCase()
  const needle = query.toLowerCase()
  let offset = 0
  for (let index = 0; index <= ordinal; index++) {
    offset = lowered.indexOf(needle, offset)
    if (offset < 0) return null
    if (index < ordinal) offset += needle.length
  }
  const locate = (position: number): [Text, number] | null => {
    for (const current of nodes) {
      const length = current.length
      if (position <= length) return [current, position]
      position -= length
    }
    return null
  }
  const start = locate(offset)
  const end = locate(offset + needle.length)
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

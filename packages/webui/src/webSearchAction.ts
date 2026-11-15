import type { MessagePart } from './components/chatShared'
import { safeWebSearchUrl, type WebSearchCitation } from './components/webSearchCitations'

export type WebSearchAction =
  | { type: 'search'; query: string; queries: string[]; sources?: WebSearchCitation[]; error?: string }
  | { type: 'open_page'; url: string }
  | { type: 'search_result'; sources: WebSearchCitation[]; error?: string }

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

const getSearchSources = (sources: unknown[]): WebSearchCitation[] => {
  const unique = new Map<string, WebSearchCitation>()
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    const record = source as Record<string, unknown>
    const url = safeWebSearchUrl(record.url)
    if (url && !unique.has(url)) unique.set(url, { url, title: cleanString(record.title) || url })
  }
  return [...unique.values()]
}

export const getWebSearchAction = (outputItem: unknown, parts: readonly MessagePart[] = []): WebSearchAction | null => {
  if (!outputItem || typeof outputItem !== 'object' || Array.isArray(outputItem)) return null
  const item = outputItem as Record<string, unknown>
  if (item.type === 'web_search_tool_result') {
    // A deferred server result may arrive in a later assistant message. Keep its
    // sources/error at that position without inventing a query or a second call.
    const content = item.content as any
    const error = content?.type === 'web_search_tool_result_error' ? cleanString(content.error_code) : null
    return { type: 'search_result', sources: Array.isArray(content) ? getSearchSources(content) : [], ...(error ? { error } : {}) }
  }
  if (item.type === 'server_tool_use' && item.name === 'web_search') {
    const input = item.input as Record<string, unknown> | undefined
    const query = cleanString(input?.query)
    if (!query) return null
    const result = parts.map(part => part.providerMeta?.anthropic?.contentBlock).find(block =>
      block?.type === 'web_search_tool_result' && block.tool_use_id === item.id)
    const content = result?.content
    const error = content && !Array.isArray(content) && content.type === 'web_search_tool_result_error'
      ? cleanString(content.error_code) : null
    return { type: 'search', query, queries: [query],
      ...(Array.isArray(content) ? { sources: getSearchSources(content) } : {}),
      ...(error ? { error } : {}),
    }
  }
  if (item.type !== 'web_search_call' || !item.action || typeof item.action !== 'object' || Array.isArray(item.action)) return null

  const action = item.action as Record<string, unknown>
  if (action.type === 'search') {
    const queries = Array.isArray(action.queries)
      ? action.queries.map(cleanString).filter((query): query is string => !!query)
      : []
    const primaryQuery = cleanString(action.query) || queries[0]
    if (!primaryQuery) return null
    return {
      type: 'search',
      query: primaryQuery,
      queries: [...new Set([primaryQuery, ...queries])],
      ...(Array.isArray(action.sources) ? { sources: getSearchSources(action.sources) } : {}),
    }
  }

  if (action.type === 'open_page') {
    const url = safeWebSearchUrl(action.url)
    return url ? { type: 'open_page', url } : null
  }

  return null
}

/** Native records keep their original protocol identity; only the display action is shared. */
export const getPartWebSearchAction = (part: MessagePart, parts: readonly MessagePart[] = []): WebSearchAction | null => {
  const block = part.providerMeta?.anthropic?.contentBlock
  if (block?.type === 'web_search_tool_result' && parts.some(candidate => {
    const call = candidate.providerMeta?.anthropic?.contentBlock
    return call?.type === 'server_tool_use' && call.name === 'web_search' && call.id === block.tool_use_id
  })) return null
  return getWebSearchAction(part.providerMeta?.openaiResponses?.outputItem ?? block, parts)
}

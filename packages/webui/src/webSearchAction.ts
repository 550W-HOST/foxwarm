import { safeWebSearchUrl, type WebSearchCitation } from './components/webSearchCitations'

export type WebSearchAction =
  | { type: 'search'; query: string; queries: string[]; sources?: WebSearchCitation[] }
  | { type: 'open_page'; url: string }

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

export const getWebSearchAction = (outputItem: unknown): WebSearchAction | null => {
  if (!outputItem || typeof outputItem !== 'object' || Array.isArray(outputItem)) return null
  const item = outputItem as Record<string, unknown>
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

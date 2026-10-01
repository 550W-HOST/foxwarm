import { WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronUp, History, Search } from 'lucide-react'
import ChatTimeline from './ChatTimeline'
import type { Message } from './chatShared'
import { formatTimelineTimeMarker } from './timelineTime'
import { API_BASE_PATH } from '../config'

type HistoryResult = {
  key: string
  sessionId: string
  kind: 'messages' | 'block' | 'unavailable'
  messages: Message[]
  firstSeq?: number
  lastSeq?: number
  hasEarlier: boolean
  hasLater: boolean
  requestedRange?: { startSeq: number; endSeq: number }
  shownRange?: { startSeq: number; endSeq: number }
  hasMoreInTarget?: boolean
  fallbackExcerpt?: string
  matchedFacts?: Array<{ kind?: string; text: string }>
  loading?: 'earlier' | 'later'
  error?: string
}

type WindowResponse = Pick<HistoryResult, 'messages' | 'firstSeq' | 'lastSeq' | 'hasEarlier' | 'hasLater' | 'hasMoreInTarget' | 'shownRange'>
const LOCATOR = /^msg#([1-9]\d*)(?:-([1-9]\d*))?$/i
const COPY_REFERENCE = /^sessionId=(\S+)\s+(msg#[1-9]\d*(?:-[1-9]\d*)?)$/i

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load history.'
}

async function readHistory(path: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`${API_BASE_PATH}${path}`, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Unable to load history.')
  return body
}

function mergeMessages(previous: Message[], incoming: Message[], direction: 'earlier' | 'later'): Message[] {
  const oldSeqs = new Set(previous.map(message => message.__meta?.seq).filter((seq): seq is number => typeof seq === 'number'))
  const unique = incoming.filter(message => !oldSeqs.has(message.__meta?.seq || -1))
  return direction === 'earlier' ? [...unique, ...previous] : [...previous, ...unique]
}

function HistoryStartTime({ messages }: { messages: readonly Message[] }) {
  const first = messages[0]
  const timestamp = first?.__meta?.contextBlock
    ? first.__meta.contextBlock.rawStartTimestamp
    : first?.__meta?.timestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0
    || !Number.isFinite(new Date(timestamp).getTime())) return null
  const time = formatTimelineTimeMarker({ timestamp })
  return <time dateTime={new Date(timestamp).toISOString()} title={time.title}>{time.text}</time>
}

function HistoryRangeRow({ result, direction, onLoad }: {
  result: HistoryResult
  direction?: 'earlier' | 'later'
  onLoad?: () => void
}) {
  const visible = result.firstSeq
    ? `msg#${result.firstSeq}${result.lastSeq && result.lastSeq !== result.firstSeq ? `–${result.lastSeq}` : ''}`
    : 'Messages'
  const selected = result.requestedRange
    ? `Selected msg#${result.requestedRange.startSeq}–${result.requestedRange.endSeq}${result.shownRange ? ` · shown ${result.shownRange.startSeq}–${result.shownRange.endSeq}` : ''}`
    : ''
  const range = selected ? `${visible} · ${selected}` : visible
  const action = direction === 'earlier' ? 'Load earlier'
    : result.hasMoreInTarget ? 'Continue selected range' : 'Load later'
  const content = <>
    <span aria-hidden="true" className="flex w-10 shrink-0 self-stretch items-center justify-center border-r border-dashed border-fw-border text-fw-text-muted">
      {direction === 'earlier' ? <ChevronUp size={16} /> : direction === 'later' ? <ChevronDown size={16} /> : null}
    </span>
    {direction && <span className="flex shrink-0 items-center px-3 font-medium">{result.loading === direction ? 'Loading…' : action}</span>}
    <span className="min-w-0 flex-1 px-3 py-2 text-right text-fw-text-muted">{range}</span>
  </>
  const className = 'flex min-h-9 w-full items-stretch border-y border-fw-border bg-fw-neutral-surface text-left text-xs text-fw-text transition-colors dark:border-fw-border'
  return direction ? (
    <button type="button" data-history-page={direction} onClick={onLoad} disabled={!!result.loading}
      aria-label={`${action}, ${range}`} className={`${className} hover:bg-fw-hover disabled:cursor-wait disabled:opacity-60`}>
      {content}
    </button>
  ) : <div data-history-range className={className}>{content}</div>
}

export default function HistorySearchView({ isMobile, groupTools, showUsageBadge, showUserMessageMetadata, knownSessions = [], onBack }: {
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
  showUserMessageMetadata: boolean
  knownSessions?: string[]
  onBack?: () => void
}) {
  const tabHeader = useWorkbenchTabHeader()
  const [query, setQuery] = useState('')
  const [agentName, setAgentName] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [results, setResults] = useState<HistoryResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const generation = useRef(0)
  const requests = useRef(new Set<AbortController>())

  const invalidate = () => {
    generation.current += 1
    requests.current.forEach(controller => controller.abort())
    requests.current.clear()
    setResults([])
    setError('')
    setSearched(false)
    setLoading(false)
  }
  useEffect(() => () => {
    generation.current += 1
    requests.current.forEach(controller => controller.abort())
    requests.current.clear()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    invalidate()
    const turn = generation.current
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    const value = query.trim()
    const copied = value.match(COPY_REFERENCE)
    const locator = copied?.[2] || (LOCATOR.test(value) ? value : '')
    const selectedSession = copied?.[1] || sessionId.trim()
    try {
      if (!value) throw new Error('Enter a search or message reference.')
      if (locator && !selectedSession) throw new Error('Choose a session to open a message reference.')
      const params = new URLSearchParams()
      let path: string
      if (locator) {
        params.set('sessionId', selectedSession)
        params.set('target', locator)
        path = `/history/window?${params}`
      } else {
        params.set('query', value)
        if (agentName.trim()) params.set('agentName', agentName.trim())
        if (selectedSession) params.set('sessionId', selectedSession)
        path = `/history/search?${params}`
      }
      const payload = await readHistory(path, controller.signal)
      if (turn !== generation.current) return
      if (locator) {
        if (!payload.messages?.length) throw new Error('No archived message found at that reference.')
        setResults([{ key: `${selectedSession}:${locator}`, sessionId: selectedSession, kind: 'messages',
          messages: payload.messages, firstSeq: payload.firstSeq, lastSeq: payload.lastSeq,
          hasEarlier: payload.hasEarlier, hasLater: payload.hasLater,
          requestedRange: payload.requestedRange, shownRange: payload.shownRange,
          hasMoreInTarget: payload.hasMoreInTarget }])
      } else setResults(payload.results || [])
      setSearched(true)
    } catch (cause) {
      if (!controller.signal.aborted && turn === generation.current) setError(errorText(cause))
    } finally {
      requests.current.delete(controller)
      if (turn === generation.current) setLoading(false)
    }
  }

  const load = async (key: string, direction: 'earlier' | 'later') => {
    const result = results.find(item => item.key === key)
    if (!result || result.loading || result.kind === 'unavailable') return
    const anchor = direction === 'earlier' ? result.firstSeq : result.lastSeq
    if (!anchor) return
    const turn = generation.current
    const controller = new AbortController()
    requests.current.add(controller)
    setResults(previous => previous.map(item => item.key === key ? { ...item, loading: direction, error: undefined } : item))
    const params = new URLSearchParams({ sessionId: result.sessionId, [direction === 'earlier' ? 'beforeSeq' : 'afterSeq']: String(anchor) })
    if (direction === 'later' && result.hasMoreInTarget && result.requestedRange) {
      params.set('targetEndSeq', String(result.requestedRange.endSeq))
    }
    try {
      const page = await readHistory(`/history/window?${params}`, controller.signal) as WindowResponse
      if (turn !== generation.current) return
      setResults(previous => previous.map(item => item.key !== key ? item : {
        ...item,
        messages: mergeMessages(item.messages, page.messages, direction),
        firstSeq: direction === 'earlier' ? page.firstSeq || item.firstSeq : item.firstSeq,
        lastSeq: direction === 'later' ? page.lastSeq || item.lastSeq : item.lastSeq,
        hasEarlier: direction === 'earlier' ? page.hasEarlier : item.hasEarlier,
        hasLater: direction === 'later' ? page.hasLater : item.hasLater,
        hasMoreInTarget: direction === 'later' ? page.hasMoreInTarget || false : item.hasMoreInTarget,
        shownRange: direction === 'later' && page.shownRange ? {
          startSeq: item.shownRange?.startSeq || item.firstSeq || page.shownRange.startSeq,
          endSeq: page.shownRange.endSeq,
        } : item.shownRange,
        loading: undefined,
      }))
    } catch (cause) {
      if (!controller.signal.aborted && turn === generation.current) setResults(previous => previous.map(item => item.key === key ? { ...item, error: errorText(cause), loading: undefined } : item))
    } finally {
      requests.current.delete(controller)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-fw-canvas px-3 py-5 text-fw-text" data-history-search-view>
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center gap-3">
          {tabHeader ? <>
            <WorkbenchTabClose className="rounded p-1 text-fw-text-muted hover:bg-fw-hover" iconClassName="h-5 w-5" />
            <WorkbenchTabIcon className="inline-flex items-center text-fw-text-muted"><History className="h-5 w-5" /></WorkbenchTabIcon>
          </> : onBack && <button type="button" onClick={onBack} className="rounded px-2 py-1 hover:bg-fw-hover">Back</button>}
          <h2 className="text-lg font-semibold text-fw-text-strong">Search history</h2>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-fw-border bg-fw-surface p-4">
          <label className="block text-sm font-medium" htmlFor="history-search-query">Search or message reference</label>
          <div className="flex gap-2">
            <input id="history-search-query" value={query} onChange={event => { invalidate(); setQuery(event.target.value) }} placeholder="Search conversations or paste sessionId=… msg#123" className="min-w-0 flex-1 rounded border border-fw-border bg-fw-canvas px-3 py-2 text-fw-text-strong" />
            <button type="submit" disabled={loading} className="inline-flex items-center gap-1 rounded bg-fw-accent px-3 py-2 text-white disabled:opacity-50"><Search size={16} /> Search</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="min-w-36 flex-1 text-xs">Agent (optional)
              <input value={agentName} onChange={event => { invalidate(); setAgentName(event.target.value) }} placeholder="All agents" className="mt-1 w-full rounded border border-fw-border bg-fw-canvas px-2 py-1.5 text-sm text-fw-text-strong" />
            </label>
            <label className="min-w-40 flex-[2] text-xs">Session (optional)
              <input list="history-known-sessions" value={sessionId} onChange={event => { invalidate(); setSessionId(event.target.value) }} placeholder="All sessions" className="mt-1 w-full rounded border border-fw-border bg-fw-canvas px-2 py-1.5 text-sm text-fw-text-strong" />
              <datalist id="history-known-sessions">{knownSessions.map(id => <option key={id} value={id} />)}</datalist>
            </label>
          </div>
        </form>
        {loading && <p role="status">Searching…</p>}
        {error && <p role="alert" className="rounded border border-fw-warning p-3 text-fw-warning">{error}</p>}
        {searched && !loading && results.length === 0 && <p>No history found.</p>}
        <div className="space-y-5" data-history-search-results>
          {results.map((result, index) => (
            <section key={`${result.key}:${index}`} data-history-result={result.key} className="min-w-0 rounded-lg border border-fw-border bg-fw-surface p-3 sm:p-4">
              <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-fw-border pb-2 text-xs text-fw-text-muted">
                <span className="font-medium text-fw-text-strong">{result.sessionId}</span>
                <HistoryStartTime messages={result.messages} />
              </header>
              {result.kind === 'unavailable' ? <p className="text-sm">The original messages are unavailable. {result.fallbackExcerpt && <span>Cached excerpt: {result.fallbackExcerpt}</span>}</p> : (
                <>
                  {result.hasEarlier && <div className="mb-3"><HistoryRangeRow result={result} direction="earlier" onLoad={() => void load(result.key, 'earlier')} /></div>}
                  {!result.hasEarlier && !result.hasLater && !!result.firstSeq && <div className="mb-3"><HistoryRangeRow result={result} /></div>}
                  <ChatTimeline sessionId={result.sessionId} messages={result.messages} isMobile={isMobile} groupTools={groupTools} showUsageBadge={showUsageBadge} showUserMessageMetadata={showUserMessageMetadata} />
                  {result.hasLater && <div className="mt-3"><HistoryRangeRow result={result} direction="later" onLoad={() => void load(result.key, 'later')} /></div>}
                  {result.matchedFacts?.map((fact, factIndex) => <p key={factIndex} className="mt-2 text-xs text-fw-text-muted">Matched memory fact{fact.kind ? ` (${fact.kind})` : ''}: {fact.text}</p>)}
                  {result.error && <p role="alert" className="mt-2 text-sm text-fw-warning">{result.error}</p>}
                </>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

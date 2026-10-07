import { useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import type { Session } from './SessionListCore'

type SessionSearchResponse = { sessions?: Session[]; hasMore?: boolean }
type SessionByIdResponse = { results?: Array<{ requestedId?: string; session?: Session | null }> }

type SessionSelectorProps = {
  value: string | null
  onChange: (sessionId: string | null) => void
  allowUnassigned?: boolean
  placeholder?: string
  disabled?: boolean
}

function displaySession(session: Session): string {
  return session.displayName?.trim() || session.id
}

function sessionLabel(session: Session): string {
  const agent = session.agent || 'main'
  return `${displaySession(session)} · ${agent} · ${session.id}`
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`, { signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`)
  return payload as T
}

export default function SessionSelector({ value, onChange, allowUnassigned = false, placeholder = 'Search Sessions', disabled = false }: SessionSelectorProps) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<Session[]>([])
  const [selected, setSelected] = useState<Session | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!value) {
      setSelected(null)
      setError('')
      return
    }
    if (selected?.id === value || selected?.aliases?.includes(value)) return
    setSelected(null)
    setError('')
    const controller = new AbortController()
    void fetch(`${API_BASE_PATH}/session-list/by-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [value], includePaths: false }),
      signal: controller.signal,
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as SessionByIdResponse
      if (!response.ok) throw new Error(payload?.results ? 'Unable to load Session.' : `Request failed (${response.status})`)
      const next = payload.results?.[0]?.session || null
      if (controller.signal.aborted) return
      if (next) setSelected(next)
      else onChange(null)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load Session.')
    })
    return () => controller.abort()
  }, [onChange, value])

  useEffect(() => {
    const normalized = query.trim()
    if (!normalized) {
      setOptions([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      const params = new URLSearchParams({ q: normalized, limit: '50' })
      void readJson<SessionSearchResponse>(`/session-list/search?${params}`, controller.signal).then(payload => {
        if (!controller.signal.aborted) setOptions(payload.sessions || [])
      }).catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to search Sessions.')
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  useEffect(() => {
    setHighlightedIndex(options.length ? 0 : -1)
  }, [options, query])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const choose = (session: Session | null) => {
    setSelected(session)
    setQuery('')
    setOpen(false)
    setError('')
    onChange(session?.id || null)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setHighlightedIndex(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open || options.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      setHighlightedIndex(current => {
        const offset = event.key === 'ArrowDown' ? 1 : -1
        return (current + offset + options.length) % options.length
      })
      return
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault()
      event.stopPropagation()
      if (options[highlightedIndex]) choose(options[highlightedIndex])
    }
  }

  const hasValue = value !== null && value !== ''

  return <div ref={rootRef} data-session-selector className="relative min-w-0">
    <div className="flex min-w-0 items-center gap-2 rounded border border-fw-border bg-fw-canvas px-2 py-1.5">
      {selected && <span className="min-w-0 flex-1 truncate text-sm text-fw-text" title={sessionLabel(selected)}>{sessionLabel(selected)}</span>}
      <input
        data-session-selector-input
        value={query}
        onChange={event => { setQuery(event.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={selected ? 'Change Session' : placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-fw-text outline-none placeholder:text-fw-text-muted disabled:opacity-60"
      />
      {allowUnassigned && <button type="button" onClick={() => choose(null)} disabled={disabled || !hasValue} className="shrink-0 text-xs text-fw-text-muted hover:text-fw-text disabled:opacity-40">Clear</button>}
    </div>
    {open && !disabled && <div data-session-selector-options className="absolute z-30 mt-1 max-h-64 w-full min-w-[18rem] overflow-y-auto rounded border border-fw-border bg-fw-surface p-1 shadow-lg">
      {loading && <p className="px-2 py-2 text-xs text-fw-text-muted">Searching…</p>}
      {error && <p role="alert" className="px-2 py-2 text-xs text-fw-danger">{error}</p>}
      {!loading && !error && !query.trim() && <p className="px-2 py-2 text-xs text-fw-text-muted">Type to search Sessions.</p>}
      {!loading && !error && query.trim() && options.length === 0 && <p className="px-2 py-2 text-xs text-fw-text-muted">No Sessions found.</p>}
      {options.map((session, index) => <button key={session.id} type="button" data-session-option={session.id} onMouseEnter={() => setHighlightedIndex(index)} onClick={() => choose(session)} className={`block w-full rounded px-2 py-2 text-left text-sm text-fw-text hover:bg-fw-hover ${index === highlightedIndex ? 'bg-fw-hover' : ''}`}>
        <span className="block truncate">{displaySession(session)}</span>
        <span className="mt-0.5 block truncate text-xs text-fw-text-muted">{session.agent || 'main'} · {session.id}</span>
      </button>)}
    </div>}
  </div>
}

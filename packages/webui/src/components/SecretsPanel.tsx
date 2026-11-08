import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { API_BASE_PATH } from '../config'

type Usage = { kind: 'provider' | 'channel' | 'mcp' | 'setting'; id: string }
type Secret = {
  name: string
  description: string
  isSet: boolean
  redactable: boolean
  updatedAt: number
  setAt?: number | null
  retiredVersions: number
  retainedUntil?: number | null
  usages: Usage[]
}
type Exposure = { label: string; count: number; lastSeenAt: number; lastSource: string; lastSessionId?: string | null }
type Payload = {
  locked: boolean
  lockMessage?: string | null
  keyFile: string
  minimumRedactableLength: number
  retiredRetentionDays: number
  secrets: Secret[]
  missing: Array<{ name: string; usages: Usage[] }>
  exposures: Exposure[]
}

const inputClass = 'w-full rounded border border-fw-border bg-fw-bg px-3 py-2 text-sm text-fw-text dark:border-fw-border dark:bg-fw-bg dark:text-fw-text'
const buttonClass = 'rounded border border-fw-border px-3 py-2 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50'
const primaryClass = 'rounded bg-fw-accent px-3 py-2 text-sm font-medium text-fw-accent-text hover:bg-fw-accent disabled:opacity-50'
const usageKinds: Record<Usage['kind'], string> = { provider: 'Model provider', channel: 'Channel', mcp: 'MCP server', setting: 'Setting' }
const sources: Record<string, string> = {
  'tool-output': 'Tool output',
  input: 'Incoming message',
  history: 'Session history',
  'model-request': 'Model request',
  embedding: 'Search indexing',
}

export function exposureSource(source: string) {
  if (source.endsWith('-reasoning')) return 'Model reasoning (left unchanged)'
  return sources[source] || source
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_PATH}/setup/secrets${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const when = (value?: number | null) => value ? new Date(value).toLocaleString() : ''
const usageText = (usages: Usage[]) => usages.map(usage => `${usageKinds[usage.kind] || usage.kind} ${usage.id}`).join(', ')

function SecretRow({ secret, minimum, locked, refresh }: { secret: Secret; minimum: number; locked: boolean; refresh: (notice?: string) => Promise<void> }) {
  const [mode, setMode] = useState<'value' | 'description' | null>(null)
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(secret.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const path = `/${encodeURIComponent(secret.name)}`
  const perform = async (action: () => Promise<string | undefined>) => {
    setBusy(true)
    setError(null)
    try {
      const notice = await action()
      setMode(null)
      setValue('')
      await refresh(notice)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The secret could not be updated.') }
    finally { setBusy(false) }
  }
  const replace = () => perform(async () => {
    const result = await request(path, json('PUT', { value }))
    return result.warning
  })
  const describe = () => perform(async () => { await request(path, json('PUT', { description })); return undefined })
  const remove = () => {
    if (!window.confirm(`Delete secret “${secret.name}”? Settings that use it stop working until a new value is saved.`)) return
    void perform(async () => { await request(path, { method: 'DELETE' }); return undefined })
  }
  const forget = () => perform(async () => { await request(`${path}/forget-retired`, json('POST', {})); return undefined })
  return <article className="rounded-lg border border-fw-border p-4" aria-label={`Secret ${secret.name}`} data-secret={secret.name}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="break-all font-mono text-sm font-semibold text-fw-text-strong">{secret.name}</h3>
        {secret.description && <p className="mt-1 break-words text-sm text-fw-text">{secret.description}</p>}
        <p className="mt-1 text-sm text-fw-muted">
          {secret.isSet ? `Updated ${when(secret.setAt ?? secret.updatedAt)}` : 'No value'}
          {secret.usages.length > 0 ? ` · Used by ${usageText(secret.usages)}` : ' · Not used'}
        </p>
        {secret.isSet && !secret.redactable && <p className="mt-1 text-sm text-fw-warning">Shorter than {minimum} characters, so it cannot be hidden from tool output and model requests.</p>}
        {secret.retiredVersions > 0 && <p className="mt-1 text-sm text-fw-muted">Previous values stay hidden in output until {when(secret.retainedUntil)}.</p>}
      </div>
      {!mode && <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy || locked} onClick={() => setMode('value')}>{secret.isSet ? 'Replace value' : 'Set value'}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => { setDescription(secret.description); setMode('description') }}>Edit description</button>
        {secret.retiredVersions > 0 && <button type="button" className={buttonClass} disabled={busy} onClick={() => void forget()}>Forget previous values</button>}
        {secret.isSet && <button type="button" className={buttonClass} disabled={busy} onClick={remove}>Delete</button>}
      </div>}
    </div>
    {mode === 'value' && <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void replace() }}>
      <input type="password" className={`${inputClass} min-w-48 flex-1`} value={value} onChange={event => setValue(event.target.value)} placeholder="New value" aria-label={`New value for ${secret.name}`} autoComplete="new-password" autoFocus />
      <button type="submit" className={primaryClass} disabled={busy || !value}>Save</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { setMode(null); setValue(''); setError(null) }}>Cancel</button>
    </form>}
    {mode === 'description' && <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void describe() }}>
      <input className={`${inputClass} min-w-48 flex-1`} value={description} onChange={event => setDescription(event.target.value)} aria-label={`Description for ${secret.name}`} autoFocus />
      <button type="submit" className={primaryClass} disabled={busy}>Save</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => { setMode(null); setError(null) }}>Cancel</button>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-fw-danger">{error}</p>}
  </article>
}

export default function SecretsPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const mounted = useRef(true)
  const nameRef = useRef<HTMLInputElement>(null)
  const refresh = useCallback(async (message?: string) => {
    setLoading(true)
    try {
      const next = await request('')
      if (mounted.current) { setData(next); setError(null); setNotice(message ?? null) }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Secrets could not be loaded.')
    } finally { if (mounted.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])
  const add = async () => {
    setAdding(true)
    setAddError(null)
    try {
      const result = await request(`/${encodeURIComponent(name.trim())}`, json('PUT', { value, ...(description.trim() ? { description: description.trim() } : {}) }))
      setName('')
      setValue('')
      setDescription('')
      await refresh(result.warning)
    } catch (cause) { setAddError(cause instanceof Error ? cause.message : 'The secret could not be saved.') }
    finally { setAdding(false) }
  }
  const dismiss = async (label: string) => {
    try { await request('/exposures/clear', json('POST', { label })); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The detection could not be dismissed.') }
  }
  const prefill = (missing: string) => { setName(missing); nameRef.current?.focus() }
  return <div className="mx-auto max-w-3xl space-y-5" data-setup-secrets>
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-fw-text-strong">Secrets</h2>
        <p className="mt-1 text-sm text-fw-text">Store API keys and tokens here, then write <code className="font-mono">{'${secret:NAME}'}</code> in model, channel or MCP settings. Saved values can be replaced but are never shown. Known values are hidden from tool output, messages and model requests.</p>
      </div>
      <button type="button" aria-label="Refresh secrets" className={buttonClass} disabled={loading} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button>
    </div>
    {data?.locked && <p role="alert" className="rounded border border-fw-danger-border p-3 text-sm text-fw-danger">{data.lockMessage || 'Secrets are unavailable.'} Settings that use secrets stay disabled until the encryption key file is restored.</p>}
    {error && <p role="alert" className="text-sm text-fw-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-fw-warning">{notice}</p>}
    {!data && loading && <p role="status" className="text-sm text-fw-muted">Loading secrets…</p>}

    {data && <form className="space-y-2 rounded-lg border border-fw-border p-4" aria-label="Add secret" onSubmit={event => { event.preventDefault(); void add() }}>
      <h3 className="font-medium text-fw-text-strong">Add secret</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block space-y-1 text-sm text-fw-text">Name
          <input ref={nameRef} className={`${inputClass} font-mono`} value={name} onChange={event => setName(event.target.value)} placeholder="openai-key" autoComplete="off" spellCheck={false} />
        </label>
        <label className="block space-y-1 text-sm text-fw-text">Value
          <input type="password" className={inputClass} value={value} onChange={event => setValue(event.target.value)} autoComplete="new-password" />
        </label>
      </div>
      <label className="block space-y-1 text-sm text-fw-text">Description
        <input className={inputClass} value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional" autoComplete="off" />
      </label>
      <p className="text-sm text-fw-muted">Names use lowercase letters, digits, “.”, “_” or “-”. Saving an existing name replaces its value.</p>
      <button type="submit" className={primaryClass} disabled={adding || data.locked || !name.trim() || !value}>{adding ? 'Saving…' : 'Save secret'}</button>
      {addError && <p role="alert" className="text-sm text-fw-danger">{addError}</p>}
    </form>}

    {data && data.missing.length > 0 && <section className="space-y-2" aria-label="Missing secrets">
      <h3 className="font-medium text-fw-text-strong">Referenced but not set</h3>
      {data.missing.map(item => <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-fw-warning-border p-3 text-sm" data-missing-secret={item.name}>
        <span className="min-w-0"><span className="break-all font-mono font-medium text-fw-text-strong">{item.name}</span> <span className="text-fw-muted">· {usageText(item.usages)}</span></span>
        <button type="button" className={buttonClass} disabled={data.locked} onClick={() => prefill(item.name)}>Set value</button>
      </div>)}
    </section>}

    {data && <section className="space-y-2" aria-label="Saved secrets">
      {data.secrets.length === 0 ? <p className="text-sm text-fw-muted">No secrets saved.</p>
        : data.secrets.map(secret => <SecretRow key={secret.name} secret={secret} minimum={data.minimumRedactableLength} locked={data.locked} refresh={refresh} />)}
    </section>}

    {data && data.exposures.length > 0 && <section className="space-y-2" aria-label="Detected values">
      <div>
        <h3 className="font-medium text-fw-text-strong">Detected values</h3>
        <p className="mt-1 text-sm text-fw-text">These values appeared in Foxwarm traffic and were hidden. If one may have been seen elsewhere, replace it with its provider.</p>
      </div>
      {data.exposures.map(item => <div key={item.label} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-fw-border p-3 text-sm" data-secret-exposure={item.label}>
        <span className="min-w-0 text-fw-text">
          <span className="break-all font-mono font-medium text-fw-text-strong">{item.label}</span>
          <span className="text-fw-muted"> · {exposureSource(item.lastSource)}{item.lastSessionId ? ` in ${item.lastSessionId}` : ''} · {when(item.lastSeenAt)}{item.count > 1 ? ` · ${item.count} times` : ''}</span>
        </span>
        <button type="button" className={buttonClass} onClick={() => void dismiss(item.label)}>Dismiss</button>
      </div>)}
    </section>}

    {data && <p className="break-all text-sm text-fw-muted">Values are encrypted with the key file <span className="font-mono">{data.keyFile}</span>. Back it up separately: a restored instance cannot read its secrets without it.</p>}
  </div>
}

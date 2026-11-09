import { useCallback, useEffect, useRef, useState } from 'react'
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

// Control styles follow the other Setup panels (Models form, Browser appearance).
const inputClass = 'w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 disabled:opacity-70'
const labelClass = 'block text-sm font-medium text-fw-text-strong'
const hintClass = 'mt-1 text-xs text-fw-text-muted'
const sectionClass = 'border-t border-fw-border pt-5 dark:border-fw-border-muted'
const headingClass = 'text-base font-semibold text-fw-text-strong'
const listClass = 'mt-4 overflow-hidden rounded-lg border border-fw-border bg-fw-surface'
const rowClass = 'flex flex-wrap items-start gap-x-4 gap-y-3 border-t border-fw-border px-4 py-3 first:border-t-0'
const nameClass = 'break-all font-mono text-sm font-medium text-fw-text-strong'
const metaClass = 'mt-1 text-xs text-fw-text-muted'
const buttonBase = 'inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium disabled:cursor-not-allowed'
const secondaryButtonClass = `${buttonBase} border border-fw-border px-3 py-1.5 text-fw-text hover:bg-fw-hover disabled:opacity-50`
const dangerButtonClass = `${buttonBase} border border-fw-border px-3 py-1.5 text-fw-text hover:border-fw-danger-border hover:bg-fw-danger-surface hover:text-fw-danger disabled:opacity-50`
const primaryButtonClass = `${buttonBase} bg-fw-accent px-4 py-2 text-fw-accent-text hover:bg-fw-accent disabled:opacity-60`
const formSecondaryButtonClass = `${buttonBase} border border-fw-border px-3 py-2 text-fw-text hover:bg-fw-hover disabled:opacity-50`
const alertClass = 'mt-4 rounded-lg border border-fw-danger-border bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger'
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

function SecretRow({ secret, minimum, locked, refresh }: { secret: Secret; minimum: number; locked: boolean; refresh: () => Promise<void> }) {
  const [mode, setMode] = useState<'value' | 'description' | null>(null)
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(secret.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const path = `/${encodeURIComponent(secret.name)}`
  const perform = async (action: () => Promise<string | undefined>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const warning = await action()
      setMode(null)
      setValue('')
      setNotice(warning ?? null)
      await refresh()
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
  const edit = (next: 'value' | 'description') => {
    setDescription(secret.description)
    setNotice(null)
    setMode(next)
  }
  const cancel = () => { setMode(null); setValue(''); setError(null) }
  return <li className={rowClass} aria-label={`Secret ${secret.name}`} data-secret={secret.name}>
    <div className="min-w-0 flex-1 basis-64">
      <div className={nameClass}>{secret.name}</div>
      {secret.description && <p className="mt-0.5 break-words text-sm text-fw-text">{secret.description}</p>}
      <p className={metaClass}>
        {secret.isSet ? `Updated ${when(secret.setAt ?? secret.updatedAt)}` : <span className="text-fw-warning">No value</span>}
        {secret.usages.length > 0 ? ` · Used by ${usageText(secret.usages)}` : ' · Not used'}
      </p>
      {secret.isSet && !secret.redactable && <p className="mt-1 text-xs text-fw-warning">Shorter than {minimum} characters, so it cannot be hidden from tool output and model requests.</p>}
      {secret.retiredVersions > 0 && <p className={metaClass}>Previous values stay hidden in output until {when(secret.retainedUntil)}.</p>}
    </div>
    {!mode && <div className="flex flex-wrap gap-2">
      <button type="button" data-secret-action="replace" className={secondaryButtonClass} disabled={busy || locked} onClick={() => edit('value')}>{secret.isSet ? 'Replace value' : 'Set value'}</button>
      <button type="button" data-secret-action="describe" className={secondaryButtonClass} disabled={busy} onClick={() => edit('description')}>Edit description</button>
      {secret.retiredVersions > 0 && <button type="button" data-secret-action="forget" className={secondaryButtonClass} disabled={busy} onClick={() => void forget()}>Forget previous values</button>}
      {secret.isSet && <button type="button" data-secret-action="delete" className={dangerButtonClass} disabled={busy} onClick={remove}>Delete</button>}
    </div>}
    {mode === 'value' && <form className="flex basis-full flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void replace() }}>
      <input type="password" className={`${inputClass} min-w-48 flex-1`} value={value} onChange={event => setValue(event.target.value)} placeholder="New value" aria-label={`New value for ${secret.name}`} autoComplete="new-password" autoFocus />
      <button type="submit" className={primaryButtonClass} disabled={busy || !value}>Save</button>
      <button type="button" className={formSecondaryButtonClass} disabled={busy} onClick={cancel}>Cancel</button>
    </form>}
    {mode === 'description' && <form className="flex basis-full flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void describe() }}>
      <input className={`${inputClass} min-w-48 flex-1`} value={description} onChange={event => setDescription(event.target.value)} aria-label={`Description for ${secret.name}`} autoFocus />
      <button type="submit" className={primaryButtonClass} disabled={busy}>Save</button>
      <button type="button" className={formSecondaryButtonClass} disabled={busy} onClick={cancel}>Cancel</button>
    </form>}
    {error && <p role="alert" className="basis-full break-words text-sm text-fw-danger">{error}</p>}
    {/* A short value's warning is already shown on the row itself. */}
    {notice && secret.redactable && <p role="status" className="basis-full break-words text-sm text-fw-warning">{notice}</p>}
  </li>
}

/** Setup's Secrets panel. A changed `refreshRequest` (the Setup Refresh action) reloads it. */
export default function SecretsPanel({ refreshRequest = 0 }: { refreshRequest?: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addNotice, setAddNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const valueRef = useRef<HTMLInputElement>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await request('')
      if (mounted.current) { setData(next); setError(null) }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Secrets could not be loaded.')
    } finally { if (mounted.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { void refresh() }, [refresh, refreshRequest])
  const add = async () => {
    setAdding(true)
    setAddError(null)
    setAddNotice(null)
    try {
      const result = await request(`/${encodeURIComponent(name.trim())}`, json('PUT', { value, ...(description.trim() ? { description: description.trim() } : {}) }))
      setName('')
      setValue('')
      setDescription('')
      setAddNotice(result.warning ?? null)
      await refresh()
    } catch (cause) { setAddError(cause instanceof Error ? cause.message : 'The secret could not be saved.') }
    finally { setAdding(false) }
  }
  const dismiss = async (label: string) => {
    try { await request('/exposures/clear', json('POST', { label })); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The detection could not be dismissed.') }
  }
  // The name is filled in, so the value field is what the user types next.
  const prefill = (missing: string) => {
    setName(missing)
    setAddNotice(null)
    valueRef.current?.focus()
  }
  const hasRows = !!data && (data.missing.length > 0 || data.secrets.length > 0)
  return <div className="flex flex-col gap-6" data-setup-secrets>
    <section aria-label="Saved secrets">
      <h2 className={headingClass}>Secrets</h2>
      <p className="mt-1 text-sm text-fw-text">Store API keys and tokens here, then write <code className="font-mono">{'${secret:NAME}'}</code> in model, channel or MCP settings. Saved values can be replaced but are never shown. Known values are hidden from tool output, messages and model requests.</p>
      {data?.locked && <p role="alert" className={alertClass}>{data.lockMessage || 'Secrets are unavailable.'} Settings that use secrets stay disabled until the encryption key file is restored.</p>}
      {error && <p role="alert" className={alertClass}>{error}</p>}
      {!data && loading && <p role="status" className="mt-4 text-sm text-fw-text-muted">Loading secrets…</p>}
      {data && !hasRows && <p className="mt-4 text-sm text-fw-text-muted">No secrets saved.</p>}
      {data && hasRows && <ul className={listClass}>
        {data.missing.map(item => <li key={item.name} className={rowClass} aria-label={`Secret ${item.name}`} data-missing-secret={item.name}>
          <div className="min-w-0 flex-1 basis-64">
            <div className={nameClass}>{item.name}</div>
            <p className={metaClass}><span className="text-fw-warning">Referenced but not set</span> · Used by {usageText(item.usages)}</p>
          </div>
          <button type="button" className={secondaryButtonClass} disabled={data.locked} onClick={() => prefill(item.name)}>Set value</button>
        </li>)}
        {data.secrets.map(secret => <SecretRow key={secret.name} secret={secret} minimum={data.minimumRedactableLength} locked={data.locked} refresh={refresh} />)}
      </ul>}
    </section>

    {data && <section className={sectionClass}>
      <h2 className={headingClass}>Add secret</h2>
      <form className="mt-4" aria-label="Add secret" onSubmit={event => { event.preventDefault(); void add() }}>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="setup-secret-name">Name</label>
            <input id="setup-secret-name" className={`${inputClass} mt-1 font-mono`} value={name} onChange={event => setName(event.target.value)} placeholder="openai-key" autoComplete="off" spellCheck={false} />
            <p className={hintClass}>Names use lowercase letters, digits, “.”, “_” or “-”. Saving an existing name replaces its value.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="setup-secret-value">Value</label>
            <input ref={valueRef} id="setup-secret-value" type="password" className={`${inputClass} mt-1`} value={value} onChange={event => setValue(event.target.value)} autoComplete="new-password" />
          </div>
          <div className="md:col-span-2">
            <label className={labelClass} htmlFor="setup-secret-description">Description</label>
            <input id="setup-secret-description" className={`${inputClass} mt-1`} value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional" autoComplete="off" />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" className={primaryButtonClass} disabled={adding || data.locked || !name.trim() || !value}>{adding ? 'Saving…' : 'Save secret'}</button>
          {addError && <p role="alert" className="min-w-0 basis-full break-words text-sm text-fw-danger sm:basis-auto">{addError}</p>}
          {addNotice && <p role="status" className="min-w-0 basis-full break-words text-sm text-fw-warning sm:basis-auto">{addNotice}</p>}
        </div>
      </form>
    </section>}

    {data && data.exposures.length > 0 && <section className={sectionClass} aria-label="Detected values">
      <h2 className={headingClass}>Detected values</h2>
      <p className="mt-1 text-sm text-fw-text">These values appeared in Foxwarm traffic and were hidden. If one may have been seen elsewhere, replace it with its provider.</p>
      <ul className={listClass}>
        {data.exposures.map(item => <li key={item.label} className={`${rowClass} items-center`} data-secret-exposure={item.label}>
          <div className="min-w-0 flex-1 basis-64">
            <div className={nameClass}>{item.label}</div>
            <p className={metaClass}>{exposureSource(item.lastSource)}{item.lastSessionId ? ` in ${item.lastSessionId}` : ''} · {when(item.lastSeenAt)}{item.count > 1 ? ` · ${item.count} times` : ''}</p>
          </div>
          <button type="button" className={secondaryButtonClass} onClick={() => void dismiss(item.label)}>Dismiss</button>
        </li>)}
      </ul>
    </section>}

    {data && <p className={`${sectionClass} break-words text-sm text-fw-text-muted`}>Values are encrypted with the key file <span className="break-all font-mono">{data.keyFile}</span>. Back it up separately: a restored instance cannot read its secrets without it.</p>}
  </div>
}

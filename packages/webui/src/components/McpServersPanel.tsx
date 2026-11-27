import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'

// A literal credential the server keeps without sending it: it stays where it is unless replaced.
type Hidden = { hidden: string; key?: string; index?: number }
type Value = string | Hidden
type ServerView = {
  transport?: string
  url?: Value
  token?: Value
  command?: string
  args?: Value[]
  cwd?: string
  env?: Record<string, Value>
  headers?: Record<string, Value>
  timeoutSeconds?: number
  enable?: boolean
  oauth?: { scope?: string; clientId?: string; hasClientSecret?: boolean }
}
type Observed = { at: number; ok: boolean; error?: string; toolCount?: number }
type OAuthStatus = { state: string; error?: string }
type ServerEntry = { name: string; revision: string; server: ServerView; observed: Observed | null; oauth?: OAuthStatus }
type Payload = { servers: ServerEntry[]; secrets: string[] }
type Pair = { key: string; value: Value }
type Form = {
  name: string
  transport: string
  url: Value
  token: Value
  command: string
  args: Value[]
  cwd: string
  env: Pair[]
  headers: Pair[]
  timeoutSeconds: string
  enable: boolean
}

class RequestError extends Error {
  constructor(message: string, readonly conflict: boolean) { super(message) }
}

const STALE_MESSAGE = 'This server changed after you opened it. Reload to get the current version; your edits will be discarded.'

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_PATH}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new RequestError(response.status === 409 ? STALE_MESSAGE : data.error || `Request failed (${response.status})`, response.status === 409)
  return data
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const serverPath = (name: string, action = '') => `/setup/mcp/${encodeURIComponent(name)}${action}`
const isHidden = (value: Value | undefined): value is Hidden => typeof value === 'object' && value !== null
const isStdio = (transport: string) => transport === 'stdio'
const enabledOf = (server: ServerView) => server.enable !== false
const messageOf = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback

const transportLabels: Record<string, string> = { auto: 'HTTP (auto-detect)', 'streamable-http': 'Streamable HTTP', sse: 'SSE', stdio: 'Local command (stdio)' }

// Width comes from the caller, so a sized field never carries a conflicting `w-full`.
const fieldClass = 'rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 disabled:opacity-70'
const inputClass = `w-full ${fieldClass}`
const labelClass = 'block text-sm font-medium text-fw-text-strong'
const hintClass = 'mt-1 text-xs text-fw-text-muted'
const headingClass = 'text-base font-semibold text-fw-text-strong'
const listClass = 'mt-4 overflow-hidden rounded-lg border border-fw-border bg-fw-surface'
const rowClass = 'flex flex-wrap items-start gap-x-4 gap-y-3 border-t border-fw-border px-4 py-3 first:border-t-0'
const nameClass = 'break-all font-mono text-sm font-medium text-fw-text-strong'
const metaClass = 'mt-1 break-words text-xs text-fw-text-muted'
const buttonBase = 'inline-flex shrink-0 items-center justify-center rounded-lg text-sm font-medium disabled:cursor-not-allowed'
const secondaryButtonClass = `${buttonBase} border border-fw-border px-3 py-1.5 text-fw-text hover:bg-fw-hover disabled:opacity-50`
const dangerButtonClass = `${buttonBase} border border-fw-border px-3 py-1.5 text-fw-text hover:border-fw-danger-border hover:bg-fw-danger-surface hover:text-fw-danger disabled:opacity-50`
const primaryButtonClass = `${buttonBase} bg-fw-accent px-4 py-2 text-fw-accent-text hover:bg-fw-accent disabled:opacity-60`
const formSecondaryButtonClass = `${buttonBase} border border-fw-border px-3 py-2 text-fw-text hover:bg-fw-hover disabled:opacity-50`
const alertClass = 'rounded-lg border border-fw-danger-border bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger'

const SECRET_LIST_ID = 'setup-mcp-secret-references'

function emptyForm(): Form {
  return { name: '', transport: 'auto', url: '', token: '', command: '', args: [], cwd: '', env: [], headers: [], timeoutSeconds: '', enable: true }
}

function formOf(entry: ServerEntry): Form {
  const server = entry.server
  const pairs = (map?: Record<string, Value>) => Object.entries(map ?? {}).map(([key, value]) => ({ key, value }))
  return {
    name: entry.name,
    transport: server.transport ?? 'auto',
    url: server.url ?? '',
    token: server.token ?? '',
    command: server.command ?? '',
    args: server.args ?? [],
    cwd: server.cwd ?? '',
    env: pairs(server.env),
    headers: pairs(server.headers),
    timeoutSeconds: server.timeoutSeconds === undefined ? '' : String(server.timeoutSeconds),
    enable: enabledOf(server),
  }
}

// The complete definition of the form's fields; omitted fields are removed by the save.
function serverOf(form: Form): Record<string, unknown> {
  const filled = (value: Value) => isHidden(value) || value.trim() !== ''
  const map = (pairs: Pair[]) => Object.fromEntries(pairs.filter(pair => pair.key.trim() !== '').map(pair => [pair.key.trim(), pair.value]))
  const server: Record<string, unknown> = { transport: form.transport, enable: form.enable }
  if (isStdio(form.transport)) {
    server.command = form.command.trim()
    const args = form.args.filter(filled)
    if (args.length > 0) server.args = args
    if (form.cwd.trim()) server.cwd = form.cwd.trim()
    const env = map(form.env)
    if (Object.keys(env).length > 0) server.env = env
  } else {
    server.url = isHidden(form.url) ? form.url : form.url.trim()
    if (filled(form.token)) server.token = form.token
    const headers = map(form.headers)
    if (Object.keys(headers).length > 0) server.headers = headers
  }
  if (form.timeoutSeconds.trim()) server.timeoutSeconds = Number(form.timeoutSeconds)
  return server
}

// A view as it was loaded, sent back unchanged apart from `enable`.
function viewWithEnabled(server: ServerView, enable: boolean): Record<string, unknown> {
  const { oauth: _oauth, ...rest } = server
  return { ...rest, enable }
}

function statusText(entry: ServerEntry, checking: boolean) {
  if (!enabledOf(entry.server)) return { text: 'Disabled', tone: 'muted' as const }
  if (checking) return { text: 'Checking…', tone: 'muted' as const }
  const observed = entry.observed
  if (!observed) return { text: 'Not checked yet', tone: 'muted' as const }
  const at = new Date(observed.at).toLocaleString()
  if (observed.ok) {
    const tools = observed.toolCount === 1 ? '1 tool' : `${observed.toolCount ?? 0} tools`
    return { text: `Connected · ${tools} · ${at}`, tone: 'success' as const }
  }
  return { text: `Connection failed · ${at} · ${observed.error ?? 'Unknown error'}`, tone: 'danger' as const }
}

const oauthLabels: Record<string, string> = {
  authorized: 'Signed in',
  authorizing: 'Sign-in in progress',
  'not-authorized': 'Sign-in needed',
  'needs-authorization': 'Sign-in needed',
  expired: 'Sign-in expired',
}

function ValueInput({ value, onChange, label, placeholder, secretList }: { value: Value; onChange: (next: Value) => void; label: string; placeholder?: string; secretList: boolean }) {
  if (isHidden(value)) {
    return <div className="flex min-w-0 flex-1 items-center gap-2" data-mcp-hidden-value>
      <span className="min-w-0 flex-1 truncate rounded-lg border border-dashed border-fw-border px-3 py-2 text-sm text-fw-text-muted">Saved value hidden</span>
      <button type="button" className={formSecondaryButtonClass} aria-label={`Replace ${label}`} onClick={() => onChange('')}>Replace</button>
    </div>
  }
  return <input className={`${fieldClass} min-w-0 flex-1`} value={value} onChange={event => onChange(event.target.value)} aria-label={label} placeholder={placeholder} list={secretList ? SECRET_LIST_ID : undefined} autoComplete="off" spellCheck={false} />
}

function PairsEditor({ pairs, onChange, label, keyPlaceholder }: { pairs: Pair[]; onChange: (next: Pair[]) => void; label: string; keyPlaceholder: string }) {
  const update = (index: number, next: Partial<Pair>) => onChange(pairs.map((pair, position) => position === index ? { ...pair, ...next } : pair))
  return <div className="mt-1 flex flex-col gap-2">
    {pairs.map((pair, index) => <div key={index} className="flex flex-wrap items-center gap-2">
      <input className={`${fieldClass} w-40 flex-none font-mono`} value={pair.key} onChange={event => update(index, { key: event.target.value })} aria-label={`${label} name ${index + 1}`} placeholder={keyPlaceholder} autoComplete="off" spellCheck={false} />
      <ValueInput value={pair.value} onChange={value => update(index, { value })} label={`${label} value ${index + 1}`} placeholder="Value or ${secret:NAME}" secretList />
      <button type="button" className={formSecondaryButtonClass} aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(pairs.filter((_, position) => position !== index))}>Remove</button>
    </div>)}
    <div><button type="button" className={secondaryButtonClass} onClick={() => onChange([...pairs, { key: '', value: '' }])}>Add {label.toLowerCase()}</button></div>
  </div>
}

function ServerForm({ initial, revision, existing, onSaved, onCancel, onReload }: {
  initial: Form
  revision: string
  existing: boolean
  onSaved: (name: string, enabled: boolean) => Promise<void>
  onCancel: () => void
  onReload: () => Promise<void>
}) {
  const [form, setForm] = useState(initial)
  // The revision the edit started from; a later Setup Refresh doesn't move it.
  const [baseRevision] = useState(revision)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<RequestError | null>(null)
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }))
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await request(serverPath(form.name.trim()), json('PUT', { server: serverOf(form), revision: baseRevision }))
      await onSaved(form.name.trim(), form.enable)
    } catch (cause) {
      setError(cause instanceof RequestError ? cause : new RequestError(messageOf(cause, 'The server could not be saved.'), false))
    } finally { setBusy(false) }
  }
  const stdio = isStdio(form.transport)
  return <form data-mcp-form className="flex basis-full flex-col gap-4 rounded-lg border border-fw-border bg-fw-canvas p-4" onSubmit={event => { event.preventDefault(); void save() }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={labelClass}>Name
        <input className={`${inputClass} mt-1 font-mono`} data-mcp-field="name" value={form.name} onChange={event => set('name', event.target.value)} disabled={existing} required autoComplete="off" spellCheck={false} />
      </label>
      <label className={labelClass}>Transport
        <select data-mcp-field="transport" className={`${inputClass} mt-1`} value={form.transport} onChange={event => set('transport', event.target.value)}>
          {Object.entries(transportLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </label>
    </div>
    {stdio ? <>
      <label className={labelClass}>Command
        <input className={`${inputClass} mt-1 font-mono`} data-mcp-field="command" value={form.command} onChange={event => set('command', event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div>
        <span className={labelClass}>Arguments</span>
        <div className="mt-1 flex flex-col gap-2">
          {form.args.map((arg, index) => <div key={index} className="flex flex-wrap items-center gap-2">
            <ValueInput value={arg} onChange={value => set('args', form.args.map((item, position) => position === index ? value : item))} label={`Argument ${index + 1}`} secretList />
            <button type="button" className={formSecondaryButtonClass} aria-label={`Remove argument ${index + 1}`} onClick={() => set('args', form.args.filter((_, position) => position !== index))}>Remove</button>
          </div>)}
          <div><button type="button" className={secondaryButtonClass} onClick={() => set('args', [...form.args, ''])}>Add argument</button></div>
        </div>
      </div>
      <label className={labelClass}>Working directory
        <input className={`${inputClass} mt-1 font-mono`} data-mcp-field="cwd" value={form.cwd} onChange={event => set('cwd', event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div>
        <span className={labelClass}>Environment variables</span>
        <PairsEditor pairs={form.env} onChange={env => set('env', env)} label="Variable" keyPlaceholder="NAME" />
      </div>
    </> : <>
      <div>
        <span className={labelClass}>URL</span>
        <div className="mt-1 flex"><ValueInput value={form.url} onChange={value => set('url', value)} label="URL" placeholder="https://example.com/mcp" secretList={false} /></div>
      </div>
      <div>
        <span className={labelClass}>Bearer token</span>
        <div className="mt-1 flex"><ValueInput value={form.token} onChange={value => set('token', value)} label="Bearer token" placeholder="${secret:NAME}" secretList /></div>
        <p className={hintClass}>Sent as the Authorization header unless a header below sets one.</p>
      </div>
      <div>
        <span className={labelClass}>Headers</span>
        <PairsEditor pairs={form.headers} onChange={headers => set('headers', headers)} label="Header" keyPlaceholder="Header-Name" />
      </div>
    </>}
    <p className={hintClass}>To use a saved secret, enter <code className="font-mono">{'${secret:NAME}'}</code>. Saved secrets are suggested as you type.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={labelClass}>Tool call timeout (seconds)
        <input className={`${inputClass} mt-1`} type="number" data-mcp-field="timeoutSeconds" min={1} max={3600} value={form.timeoutSeconds} onChange={event => set('timeoutSeconds', event.target.value)} placeholder="60" />
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-fw-text-strong">
        <input type="checkbox" checked={form.enable} onChange={event => set('enable', event.target.checked)} />
        Enabled
      </label>
    </div>
    {error && <div role="alert" data-mcp-form-error className={alertClass}>
      <p className="break-words">{error.message}</p>
      {error.conflict && <button type="button" data-mcp-reload className={`${secondaryButtonClass} mt-2`} onClick={() => void onReload()}>Reload server</button>}
    </div>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className={primaryButtonClass} disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Save server'}</button>
      <button type="button" className={formSecondaryButtonClass} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>
}

// Setup's MCP panel: outbound MCP servers. Each change carries the revision of the server it
// was made from; a refusal offers to reload. Connection status is the last observed outcome,
// from Sessions or an explicit check; opening the panel never connects.
export default function McpServersPanel({ refreshRequest = 0 }: { refreshRequest?: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // `null` closed, '' a new server, otherwise the server being edited.
  const [editing, setEditing] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, RequestError>>({})
  const [busyRow, setBusyRow] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await request('/setup/mcp') as Payload
      if (mounted.current) { setData(next); setLoadError(null) }
      return next
    } catch (cause) {
      if (mounted.current) setLoadError(messageOf(cause, 'MCP servers could not be loaded.'))
      return null
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { void refresh() }, [refresh, refreshRequest])

  const setRowError = (name: string, error: RequestError | null) => setRowErrors(current => {
    const next = { ...current }
    if (error) next[name] = error
    else delete next[name]
    return next
  })

  const check = useCallback(async (name: string) => {
    setChecking(current => new Set(current).add(name))
    try {
      const result = await request(serverPath(name, '/check'), json('POST', {}))
      if (!mounted.current) return
      setData(current => current && { ...current, servers: current.servers.map(entry => entry.name === name ? { ...entry, observed: result.observed } : entry) })
      setRowError(name, null)
    } catch (cause) {
      if (mounted.current) setRowError(name, cause instanceof RequestError ? cause : new RequestError(messageOf(cause, 'The server could not be checked.'), false))
    } finally {
      if (mounted.current) setChecking(current => { const next = new Set(current); next.delete(name); return next })
    }
  }, [])

  const checkAll = () => {
    for (const entry of data?.servers ?? []) if (enabledOf(entry.server)) void check(entry.name)
  }

  const perform = async (entry: ServerEntry, action: () => Promise<unknown>) => {
    setBusyRow(entry.name)
    setRowError(entry.name, null)
    try {
      await action()
      await refresh()
      return true
    } catch (cause) {
      setRowError(entry.name, cause instanceof RequestError ? cause : new RequestError(messageOf(cause, 'The server could not be updated.'), false))
      return false
    } finally { setBusyRow(null) }
  }

  const toggle = async (entry: ServerEntry) => {
    const enable = !enabledOf(entry.server)
    const ok = await perform(entry, () => request(serverPath(entry.name), json('PUT', { server: viewWithEnabled(entry.server, enable), revision: entry.revision })))
    if (ok && enable) void check(entry.name)
  }

  // The row whose Delete is awaiting confirmation.
  const [confirming, setConfirming] = useState<string | null>(null)
  const remove = async (entry: ServerEntry) => {
    // A refusal is shown on the row in place of the confirmation.
    await perform(entry, () => request(serverPath(entry.name, '/delete'), json('POST', { revision: entry.revision })))
    if (mounted.current) setConfirming(null)
  }

  const signIn = async (entry: ServerEntry) => {
    // Opened before the request so the browser treats it as a direct result of the click.
    const popup = window.open('', '_blank')
    try {
      const result = await request(`/setup/authorizations/${encodeURIComponent(entry.name)}/authorize`, json('POST', {}))
      if (popup) { popup.opener = null; popup.location.href = result.authorizationUrl }
      else window.location.assign(result.authorizationUrl)
    } catch (cause) {
      popup?.close()
      setRowError(entry.name, new RequestError(messageOf(cause, 'Sign-in could not start.'), false))
    }
  }

  const openForm = (name: string) => {
    setEditing(name)
    setFormKey(current => current + 1)
  }

  const saved = async (name: string, enabled: boolean) => {
    setEditing(null)
    await refresh()
    // The user just changed this server, so show how it connects now.
    if (enabled) void check(name)
  }

  const reloadForm = async (name: string) => {
    const next = await refresh()
    if (next && !next.servers.some(entry => entry.name === name)) setEditing(null)
    else setFormKey(current => current + 1)
  }

  const servers = data?.servers ?? []
  const editedEntry = editing ? servers.find(entry => entry.name === editing) : undefined
  return <div className="flex flex-col gap-4" data-setup-mcp>
    <datalist id={SECRET_LIST_ID}>
      {(data?.secrets ?? []).map(name => <option key={name} value={`\${secret:${name}}`} />)}
    </datalist>
    <section aria-label="MCP servers">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className={headingClass}>MCP servers</h2>
          <p className="mt-1 text-sm text-fw-text">External MCP servers whose tools Agents can use. Changes apply right away.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-mcp-check-all className={secondaryButtonClass} disabled={!servers.some(entry => enabledOf(entry.server))} onClick={checkAll}>Check all</button>
          <button type="button" data-mcp-add className={secondaryButtonClass} disabled={editing === ''} onClick={() => openForm('')}>Add server</button>
        </div>
      </div>
      {loadError && <p role="alert" className={`${alertClass} mt-4`}>{loadError}</p>}
      {editing === '' && <div className="mt-4">
        <ServerForm key={formKey} initial={emptyForm()} revision="absent" existing={false} onSaved={saved} onCancel={() => setEditing(null)} onReload={async () => { await refresh(); setEditing(null) }} />
      </div>}
      {data && servers.length === 0 && editing !== '' && <p className="mt-4 text-sm text-fw-text-muted" data-mcp-empty>No MCP servers yet.</p>}
      {servers.length > 0 && <ul className={listClass}>
        {servers.map(entry => {
          const status = statusText(entry, checking.has(entry.name))
          const enabled = enabledOf(entry.server)
          const target = isStdio(entry.server.transport ?? 'auto') ? entry.server.command : isHidden(entry.server.url) ? null : entry.server.url
          const rowError = rowErrors[entry.name]
          const busy = busyRow === entry.name
          return <li key={entry.name} className={rowClass} data-mcp-server={entry.name} aria-label={`MCP server ${entry.name}`}>
            <div className="min-w-0 flex-1 basis-64">
              <div className={nameClass}>{entry.name}</div>
              <p className={metaClass}>{transportLabels[entry.server.transport ?? 'auto'] ?? entry.server.transport}{target ? ` · ${target}` : ''}</p>
              <p data-mcp-status={!enabled ? 'disabled' : checking.has(entry.name) ? 'checking' : !entry.observed ? 'unknown' : entry.observed.ok ? 'connected' : 'failing'} className={`mt-1 break-words text-xs ${status.tone === 'success' ? 'text-fw-success' : status.tone === 'danger' ? 'text-fw-danger' : 'text-fw-text-muted'}`}>{status.text}</p>
              {entry.oauth && <p className={metaClass} data-mcp-oauth={entry.oauth.state}>{oauthLabels[entry.oauth.state] ?? entry.oauth.state}{entry.oauth.error ? `: ${entry.oauth.error}` : ''}</p>}
            </div>
            {editing !== entry.name && confirming === entry.name && <div data-mcp-confirm-delete className="flex basis-full flex-wrap items-center gap-2 rounded-lg border border-fw-danger-border bg-fw-danger-surface px-3 py-2">
              <p className="min-w-0 flex-1 basis-64 break-words text-sm text-fw-text-strong">Delete <code className="font-mono font-semibold">{entry.name}</code>? Agents lose its tools, and its sign-in is removed.</p>
              <button type="button" data-mcp-action="confirm-delete" className={dangerButtonClass} disabled={busy} onClick={() => void remove(entry)}>Delete</button>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            </div>}
            {editing !== entry.name && confirming !== entry.name && <div className="flex flex-wrap gap-2">
              {entry.oauth && entry.oauth.state !== 'authorized' && entry.oauth.state !== 'authorizing' && enabled && <button type="button" data-mcp-action="sign-in" className={secondaryButtonClass} disabled={busy} onClick={() => void signIn(entry)}>Sign in</button>}
              {enabled && <button type="button" data-mcp-action="check" className={secondaryButtonClass} disabled={busy || checking.has(entry.name)} onClick={() => void check(entry.name)}>Check</button>}
              <button type="button" data-mcp-action="toggle" className={secondaryButtonClass} disabled={busy} onClick={() => void toggle(entry)}>{enabled ? 'Disable' : 'Enable'}</button>
              <button type="button" data-mcp-action="edit" className={secondaryButtonClass} disabled={busy} onClick={() => openForm(entry.name)}>Edit</button>
              <button type="button" data-mcp-action="delete" className={dangerButtonClass} disabled={busy} onClick={() => setConfirming(entry.name)}>Delete</button>
            </div>}
            {editing === entry.name && editedEntry && <ServerForm key={formKey} initial={formOf(editedEntry)} revision={editedEntry.revision} existing onSaved={saved} onCancel={() => setEditing(null)} onReload={() => reloadForm(entry.name)} />}
            {rowError && <div role="alert" data-mcp-row-error className={`${alertClass} basis-full`}>
              <p className="break-words">{rowError.message}</p>
              {rowError.conflict && <button type="button" data-mcp-reload className={`${secondaryButtonClass} mt-2`} onClick={() => { setRowError(entry.name, null); void refresh() }}>Reload server</button>}
            </div>}
          </li>
        })}
      </ul>}
    </section>
  </div>
}

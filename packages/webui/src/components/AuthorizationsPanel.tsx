import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { API_BASE_PATH } from '../config'

type Authorization = {
  name: string
  enabled: boolean
  url?: string
  transport: string
  authentication: 'static' | 'oauth'
  hasStaticAuthorization: boolean
  state: string
  scope?: string
  requestedScope?: string
  grantedScope?: string
  clientId?: string
  hasClientSecret: boolean
  error?: string
}
type Payload = { servers: Authorization[]; callbackUrl?: string; publicUrlError?: string }
const states: Record<string, string> = {
  static: 'Static authentication', 'not-authorized': 'Not authorized', authorizing: 'Waiting for authorization',
  authorized: 'Authorized', expired: 'Access expired', 'needs-authorization': 'Authorization needed',
}
const inputClass = 'w-full rounded border border-fw-border bg-fw-bg px-3 py-2 text-sm text-fw-text dark:border-fw-border dark:bg-fw-bg dark:text-fw-text'
const buttonClass = 'rounded border border-fw-border px-3 py-2 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50'

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_PATH}/setup/authorizations${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

function AuthorizationRow({ server, callbackUrl, refresh, authorize }: {
  server: Authorization
  callbackUrl?: string
  refresh: () => Promise<void>
  authorize: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState(server.authentication)
  const [scope, setScope] = useState(server.scope || '')
  const [clientId, setClientId] = useState(server.clientId || '')
  const [clientSecret, setClientSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [replaceStatic, setReplaceStatic] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const path = `/${encodeURIComponent(server.name)}`
  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Authorization could not be updated.') }
    finally { setBusy(false) }
  }
  const save = async () => perform(async () => {
    await request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      authentication: mode, scope: scope || undefined, clientId: clientId || undefined,
      ...(clearSecret ? { clientSecret: null } : clientSecret ? { clientSecret } : clientId !== (server.clientId || '') ? { clientSecret: null } : {}),
      replaceStaticAuthorization: replaceStatic,
    }) })
    setClientSecret('')
    setClearSecret(false)
    setEditing(false)
    await refresh()
  })
  const openSettings = () => {
    setMode(server.authentication)
    setScope(server.scope || '')
    setClientId(server.clientId || '')
    setClientSecret('')
    setClearSecret(false)
    setReplaceStatic(false)
    setError(null)
    setEditing(true)
  }
  return <article className="rounded-lg border border-fw-border p-4" aria-label={`${server.name} authorization`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="break-words font-semibold text-fw-text">{server.name}</h3>
        <p className="break-all text-sm text-fw-muted">{server.url}</p>
        <p className="mt-1 text-sm text-fw-muted">{states[server.state] || 'Authorization unavailable'}{!server.enabled ? ' · Server disabled' : ''}</p>
      </div>
      <button type="button" className={buttonClass} disabled={busy} onClick={openSettings}>Configure</button>
    </div>
    {server.requestedScope && <p className="mt-3 break-words text-sm text-fw-text"><span className="font-medium">Requested scopes: </span>{server.requestedScope}</p>}
    {server.grantedScope !== undefined && <p className="mt-1 break-words text-sm text-fw-text"><span className="font-medium">Granted scopes: </span>{server.grantedScope || 'None'}</p>}
    {server.error && <p className="mt-2 text-sm text-fw-warning">{server.error}</p>}
    {server.authentication === 'oauth' && !editing && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={busy || !server.enabled || !callbackUrl}
        onClick={() => void perform(() => authorize(server.name))}>
        <ExternalLink className="mr-1 inline h-4 w-4" aria-hidden="true" />{server.state === 'not-authorized' ? 'Authorize' : 'Reauthorize'}
      </button>
      <button type="button" className={buttonClass} disabled={busy || server.state === 'not-authorized'}
        onClick={() => void perform(async () => { await request(`${path}/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refresh() })}>Disconnect</button>
    </div>}
    {editing && <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="block space-y-1 text-sm text-fw-text">Authentication
        <select className={inputClass} value={mode} onChange={event => setMode(event.target.value as 'static' | 'oauth')}>
          <option value="static">Static credentials</option><option value="oauth">OAuth</option>
        </select>
      </label>
      {mode === 'static' ? <p className="text-sm text-fw-muted">Uses this server's configured token or headers. OAuth credentials will no longer be used.</p> : <>
        <label className="block space-y-1 text-sm text-fw-text">Requested scopes
          <input className={inputClass} value={scope} onChange={event => setScope(event.target.value)} placeholder="Space-separated scopes (optional)" autoComplete="off" />
        </label>
        <label className="block space-y-1 text-sm text-fw-text">Pre-registered client ID
          <input className={inputClass} value={clientId} onChange={event => setClientId(event.target.value)} placeholder="Optional" autoComplete="off" />
        </label>
        <label className="block space-y-1 text-sm text-fw-text">Client secret
          <input type="password" className={inputClass} value={clientSecret} onChange={event => setClientSecret(event.target.value)}
            placeholder={server.hasClientSecret ? 'Configured · leave blank to keep' : 'Optional'} autoComplete="new-password" />
        </label>
        {server.hasClientSecret && <label className="flex items-center gap-2 text-sm text-fw-text"><input type="checkbox" checked={clearSecret} onChange={event => setClearSecret(event.target.checked)} />Remove saved client secret</label>}
        <p className="text-sm text-fw-muted">Without a client ID, Foxwarm uses supported client metadata or dynamic registration.</p>
        {server.hasStaticAuthorization && <label className="flex items-start gap-2 text-sm text-fw-text"><input type="checkbox" checked={replaceStatic} onChange={event => setReplaceStatic(event.target.checked)} />Replace this server's static Authorization with OAuth</label>}
      </>}
      <div className="flex gap-2"><button className={buttonClass} type="submit" disabled={busy}>Save</button>
        <button className={buttonClass} type="button" disabled={busy} onClick={() => { setEditing(false); setClientSecret(''); setError(null) }}>Cancel</button></div>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-fw-danger">{error}</p>}
  </article>
}

export default function AuthorizationsPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const popup = useRef<Window | null>(null)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await request('')
      if (mounted.current) { setData(next); setError(null) }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Authorizations could not be loaded.')
    } finally { if (mounted.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const completed = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup.current || event.data?.type !== 'foxwarm-mcp-oauth') return
      popup.current?.close()
      popup.current = null
      void refresh().then(() => { if (!event.data.success) setError('Authorization was not completed. Review the server settings and try again.') })
    }
    window.addEventListener('message', completed)
    return () => { mounted.current = false; window.removeEventListener('message', completed) }
  }, [refresh])
  const authorize = async (name: string) => {
    const opened = window.open('about:blank', 'foxwarm-mcp-authorization', 'popup,width=720,height=800')
    if (!opened) throw new Error('Allow popups for this instance, then authorize again.')
    popup.current = opened
    try {
      const result = await request(`/${encodeURIComponent(name)}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      opened.location.href = result.authorizationUrl
      await refresh()
    } catch (cause) { opened.close(); popup.current = null; throw cause }
  }
  return <div className="mx-auto max-w-3xl space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold text-fw-text">MCP authorizations</h2>
        <p className="mt-1 text-sm text-fw-muted">Manage third-party accounts shared by this instance. Existing tool permissions still apply.</p></div>
      <button type="button" aria-label="Refresh authorizations" className={buttonClass} disabled={loading} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button>
    </div>
    {data?.publicUrlError && <p role="status" className="rounded border border-fw-border p-3 text-sm text-fw-warning">{data.publicUrlError}</p>}
    {data?.callbackUrl && <p className="break-all text-sm text-fw-muted"><span className="font-medium">Callback URL: </span>{data.callbackUrl}</p>}
    {error && <p role="alert" className="text-sm text-fw-danger">{error}</p>}
    {!data && loading && <p role="status" className="text-sm text-fw-muted">Loading authorizations…</p>}
    {data?.servers.length === 0 && <p className="text-sm text-fw-muted">No HTTP MCP servers are configured.</p>}
    {data?.servers.map(server => <AuthorizationRow key={server.name} server={server} callbackUrl={data.callbackUrl} refresh={refresh} authorize={authorize} />)}
  </div>
}

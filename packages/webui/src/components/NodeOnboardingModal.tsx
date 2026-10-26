import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Plus, RefreshCw, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'

type PendingRequest = { id: string; requestedName: string; nodeType: string; requestedAt: number; connected: boolean }
type PendingPage = { items: PendingRequest[]; total: number; nextOffset: number | null }
type Commands = Record<string, string>
type CreatedNode = { nodeId: string; baseUrl: string; authToken: string; commands: Commands }

export function useNodePendingApprovals(enabled: boolean) {
  const [page, setPage] = useState<PendingPage>({ items: [], total: 0, nextOffset: null })
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let request: AbortController | undefined
    const load = async (force = false) => {
      if (disposed || document.hidden || (request && !force)) return
      request?.abort()
      const controller = new AbortController(); request = controller
      try {
        const response = await fetch(`${API_BASE_PATH}/nodes/onboarding/pending?offset=${offset}`, { signal: controller.signal, cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || 'Could not load pending requests.')
        if (!disposed && request === controller) {
          setPage(payload); setError('')
          if (!payload.items.length && offset > 0 && payload.total <= offset) setOffset(Math.max(0, Math.floor((Math.max(1, payload.total) - 1) / 50) * 50))
        }
      } catch (failure) {
        if (!disposed && request === controller && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load pending requests.')
      } finally { if (request === controller) request = undefined }
    }
    reloadRef.current = () => load(true)
    const visibility = () => { if (document.hidden) { request?.abort(); request = undefined } else void load(true) }
    void load()
    const timer = window.setInterval(() => { void load() }, 5000)
    document.addEventListener('visibilitychange', visibility)
    return () => { disposed = true; request?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); reloadRef.current = async () => {} }
  }, [enabled, offset])
  const refresh = useCallback(() => reloadRef.current(), [])
  return { ...page, offset, setOffset, error, refresh }
}

const methods = [
  { id: 'bareMetal', label: 'Linux CLI', detail: 'Install a full CLI Node on a Linux host.' },
  { id: 'interactive', label: 'Interactive CLI', detail: 'Open the CLI with local tool approvals and chat.' },
  { id: 'windowsShell', label: 'Windows Shell', detail: 'Use Windows PowerShell for commands only, without Node.js.' },
  { id: 'shell', label: 'Linux Shell', detail: 'Use POSIX sh and curl for commands only.' },
  { id: 'docker', label: 'Docker', detail: 'Run the CLI Node in a container.' },
  { id: 'browser', label: 'Browser', detail: 'Share existing Chrome, Chromium, or Firefox tabs and windows.' },
  { id: 'windows', label: 'Windows CLI', detail: 'Download and run the PowerShell launcher.' },
]

export default function NodeOnboardingModal({ pending, onClose, onNodesChanged }: {
  pending: ReturnType<typeof useNodePendingApprovals>
  onClose: () => void
  onNodesChanged: () => Promise<void>
}) {
  const [method, setMethod] = useState('bareMetal')
  const [baseUrl, setBaseUrl] = useState('')
  const [nodeId, setNodeId] = useState('my-node')
  const [installDir, setInstallDir] = useState('/opt/foxwarm-node')
  const [commands, setCommands] = useState<Commands>({})
  const [tokenMode, setTokenMode] = useState(false)
  const [created, setCreated] = useState<CreatedNode | null>(null)
  const shellOnly = method === 'shell' || method === 'windowsShell'
  const direct = method !== 'browser' && (shellOnly || tokenMode)
  const address = direct && created ? created.baseUrl : baseUrl
  const name = direct && created ? created.nodeId : nodeId
  const [install, setInstall] = useState(false)
  const [compose, setCompose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [browserKind, setBrowserKind] = useState<'chrome' | 'firefox'>('chrome')
  const [browserSetup, setBrowserSetup] = useState<{ baseUrl: string; pairingToken: string } | null>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState('')
  const [approvalNotice, setApprovalNotice] = useState('')
  const requests = useRef(new Set<AbortController>())
  const mounted = useRef(true)
  const closeRef = useRef(onClose); closeRef.current = onClose
  const dialogRef = useRef<HTMLElement | null>(null)

  const post = useCallback(async (path: string, body: object) => {
    const controller = new AbortController(); requests.current.add(controller)
    try {
      const response = await fetch(`${API_BASE_PATH}/nodes/onboarding/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'The request could not be completed.')
      return payload
    } finally { requests.current.delete(controller) }
  }, [])

  useEffect(() => {
    mounted.current = true
    const previousFocus = document.activeElement
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab') return
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') || [])]
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus()
    document.addEventListener('keydown', escape)
    setBusy(true)
    const fallbackUrl = `${window.location.origin}${API_BASE_PATH.slice(0, -4)}`
    void post('commands', { fallbackUrl }).then(payload => {
      if (mounted.current) { setBaseUrl(payload.baseUrl); setCommands(payload.commands) }
    }).catch(failure => { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not load setup commands.') })
      .finally(() => { if (mounted.current) setBusy(false) })
    return () => { mounted.current = false; requests.current.forEach(controller => controller.abort()); requests.current.clear(); document.removeEventListener('keydown', escape); if (previousFocus instanceof HTMLElement) previousFocus.focus() }
  }, [post])

  const updateCommands = async () => {
    setBusy(true); setError(''); setCopied(false)
    try {
      const payload = await post('commands', { baseUrl: address, nodeId: name, installDir, ...(direct && created ? { authToken: created.authToken } : {}) })
      if (mounted.current) {
        if (direct && created) setCreated({ ...created, commands: payload.commands })
        else { setBaseUrl(payload.baseUrl); setCommands(payload.commands) }
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not update commands.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const createNode = async () => {
    setBusy(true); setError(''); setCopied(false)
    try {
      const payload = await post('create', { baseUrl, nodeId, installDir })
      if (mounted.current) { setCreated(payload); await onNodesChanged() }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not create this Node.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const approve = async (request: PendingRequest) => {
    setApproving(request.id); setApprovalError(''); setApprovalNotice('')
    try {
      const payload = await post('approve', { pendingId: request.id })
      if (mounted.current) setApprovalNotice(`${payload.nodeId} approved.${payload.deliveredLive ? '' : ' Start the Node again to connect.'}`)
      await Promise.all([pending.refresh(), onNodesChanged()])
    } catch (failure) {
      if (mounted.current) { setApprovalError(failure instanceof Error ? failure.message : 'Could not approve this request.'); await pending.refresh() }
    } finally { if (mounted.current) setApproving(null) }
  }
  const loadBrowserSetup = async () => {
    setBusy(true); setError('');
    try { const payload = await post('browser', { baseUrl }); if (mounted.current) setBrowserSetup(payload) }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not load Browser setup.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const commandKey = method === 'bareMetal' && install ? 'bareMetalInstall' : method === 'docker' && compose ? 'manualCompose' : method
  const command = (direct ? created?.commands[commandKey] : commands[commandKey]) || ''
  const fieldClass = 'mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border'
  const close = useCallback(() => closeRef.current(), [])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="node-onboarding-title" className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-fw-border bg-fw-surface p-5 text-fw-text shadow-xl">
        <div className="flex items-center justify-between gap-3"><div><h2 id="node-onboarding-title" className="text-lg font-semibold text-fw-text-strong">New nodes</h2><p className="mt-1 text-sm text-fw-text-muted">Choose how to connect a new Node.</p></div><button type="button" aria-label="Close New nodes" onClick={close} className="rounded-lg p-2 hover:bg-fw-hover"><X className="h-5 w-5" /></button></div>
        <div className="mt-4 flex flex-wrap gap-2">{methods.map(item => <button key={item.id} type="button" disabled={busy} aria-pressed={method === item.id} onClick={() => { setMethod(item.id); setCopied(false); setError('') }} className={`rounded-lg border px-3 py-2 text-sm ${method === item.id ? 'border-fw-accent-border bg-fw-accent-surface text-fw-accent' : 'border-fw-border hover:bg-fw-hover'}`}>{item.label}</button>)}</div>
        <p className="mt-2 text-xs text-fw-text-muted">{methods.find(item => item.id === method)?.detail}</p>
        {method === 'browser' ? <div className="mt-4 space-y-3 text-sm">
          <label className="block text-xs font-medium">Browser<select aria-label="Browser package" value={browserKind} onChange={event => setBrowserKind(event.target.value as 'chrome' | 'firefox')} className={fieldClass}><option value="chrome">Chrome / Chromium</option><option value="firefox">Firefox 153+</option></select></label>
          <ol className="list-decimal space-y-2 pl-5">
            <li><a className="text-fw-accent underline" href={`${API_BASE_PATH.slice(0, -4)}/node/browser-extension${browserKind === 'firefox' ? '-firefox' : ''}.zip`} download>Download Browser Node</a> and extract the ZIP.</li>
            {browserKind === 'firefox' ? <li>Open about:debugging → This Firefox → Load Temporary Add-on, and select manifest.json in the extracted folder. Load it again after restarting Firefox; this package is unsigned.</li> : <li>Open Chrome or Chromium extensions, enable Developer mode, choose Load unpacked, and select the extracted folder.</li>}
            <li>Open the extension, enter the Main address and pairing token below, then Connect. Approve the request in Pending approvals.</li>
            <li>Share a tab or window with Ask or Auto in the extension. New tabs are Off unless a shared window or site rule includes them.</li>
          </ol>
          {browserKind === 'firefox' ? <p>Firefox needs broad page-host access for target-tab screenshots and DOM operations. Sharing still limits Agent access. Actions use synthetic DOM events; trusted mouse input and editing keys are unavailable. Enable optional page JavaScript in the extension when needed. Pin its icon to see pending Ask counts, then open the popup to review. Use Stop to disconnect.</p> : <p>Page operations show Chrome’s debugging banner. Cancel or the extension’s Stop button stops Browser Node. Sharing is controlled by the extension; debugger permission is not isolated by window. Avoid editing the same tab at the same time as an Agent.</p>}
          <label className="block text-xs font-medium">Main address<input aria-label="Browser Main address" disabled={busy} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setBrowserSetup(null) }} className={fieldClass} /></label>
          <button type="button" disabled={busy || !baseUrl} onClick={() => void loadBrowserSetup()} className="rounded-lg border border-fw-border px-3 py-2">Show pairing details</button>
          {browserSetup ? <div className="space-y-2 rounded-lg border border-fw-border p-3"><p className="break-all">{browserSetup.baseUrl}</p><label className="block text-xs">Pairing token<input aria-label="Browser pairing token" type="password" readOnly value={browserSetup.pairingToken} className={fieldClass} /></label><button type="button" onClick={() => void navigator.clipboard.writeText(browserSetup.pairingToken).catch(() => setError('Copy failed. Select the token and copy it manually.'))}>Copy pairing token</button><p className="text-xs text-fw-text-muted">Keep this token private. The extension download contains no credentials.</p></div> : null}
        </div> : null}
        {method !== 'browser' ? <>
        {!shellOnly ? <fieldset disabled={busy} className="mt-3 flex flex-wrap gap-4 text-sm"><legend className="mb-1 text-xs font-medium">Authentication</legend>{[{ value: false, label: 'Pairing approval' }, { value: true, label: 'Pre-created token' }].map(mode => <label key={mode.label} className="flex items-center gap-2"><input type="radio" name="node-authentication" checked={tokenMode === mode.value} onChange={() => { setTokenMode(mode.value); setCopied(false); setError('') }} />{mode.label}</label>)}</fieldset> : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium">Reachable address<input aria-label="Reachable address" disabled={busy || (direct && !!created)} value={address} onChange={event => { setBaseUrl(event.target.value); setCommands({}); setCopied(false) }} className={fieldClass} /></label>
          <label className="text-xs font-medium">Node name<input aria-label="Node name" value={name} onChange={event => { setNodeId(event.target.value); setCommands({}); setCopied(false) }} disabled={busy || (direct && !!created)} className={fieldClass} /></label>
          {method === 'bareMetal' ? <label className="text-xs font-medium">Installation directory<input aria-label="Installation directory" disabled={busy} value={installDir} onChange={event => { setInstallDir(event.target.value); setCommands({}); setCreated(current => current ? { ...current, commands: { ...current.commands, bareMetal: '', bareMetalBackground: '', bareMetalInstall: '' } } : null); setCopied(false) }} className={fieldClass} /></label> : null}
        </div>
        {method === 'bareMetal' ? <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={install} onChange={event => { setInstall(event.target.checked); setCopied(false) }} />Start automatically with systemd</label> : null}
        {method === 'docker' ? <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={compose} onChange={event => { setCompose(event.target.checked); setCopied(false) }} />Manual Docker Compose</label> : null}
        <div className="mt-3 flex items-center gap-2">
          {direct && !created ? <button type="button" disabled={busy || !address || !name} onClick={() => void createNode()} className="inline-flex items-center gap-2 rounded-lg bg-fw-accent px-3 py-2 text-sm font-medium text-fw-accent-text disabled:opacity-50"><Plus className="h-4 w-4" />Create</button> : !shellOnly ? <button type="button" disabled={busy || !address || !name} onClick={() => void updateCommands()} className="inline-flex items-center gap-2 rounded-lg border border-fw-border px-3 py-2 text-sm hover:bg-fw-hover disabled:opacity-50"><RefreshCw className="h-4 w-4" />Update command</button> : null}
          {busy ? <span role="status" className="text-xs text-fw-text-muted">Loading…</span> : null}
        </div>
        {direct && created ? <p className="mt-2 text-sm">{created.nodeId} created. Copy its command before closing.</p> : null}
        {error ? <p role="alert" className="mt-3 text-sm text-fw-danger">{error}</p> : null}
        {command ? <div className="mt-4 rounded-xl border border-fw-border bg-fw-canvas"><div className="flex items-center justify-between gap-2 border-b border-fw-border px-3 py-2"><span className="text-xs text-fw-text-muted">Run on the new Node</span><button type="button" onClick={() => { void navigator.clipboard.writeText(command).then(() => { if (mounted.current) setCopied(true) }).catch(() => { if (mounted.current) setError('Copy failed. Select the command and copy it manually.') }) }} className="inline-flex items-center gap-1.5 text-xs font-medium text-fw-accent">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy command'}</button></div><pre data-node-command className="overflow-x-auto whitespace-pre-wrap break-all p-3 text-xs leading-5"><code>{command}</code></pre></div> : null}
        <p className="mt-2 text-xs text-fw-text-muted">Keep setup commands private. They contain credentials.</p>
        </> : error ? <p role="alert" className="mt-3 text-sm text-fw-danger">{error}</p> : null}
        <div className="mt-5 border-t border-fw-border pt-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-fw-text-strong">Pending approvals{pending.total ? ` (${pending.total})` : ''}</h3><button type="button" onClick={() => { setApprovalError(''); setApprovalNotice(''); void pending.refresh() }} aria-label="Refresh pending approvals" className="rounded-lg p-2 hover:bg-fw-hover"><RefreshCw className="h-4 w-4" /></button></div>
          <p className="mt-1 text-xs text-fw-text-muted">Approve only requests from Nodes you recognize.</p>
          {pending.error || approvalError ? <p role="alert" className="mt-2 text-sm text-fw-danger">{approvalError || pending.error}</p> : null}
          {approvalNotice ? <p role="status" className="mt-2 text-sm text-fw-accent">{approvalNotice}</p> : null}
          <div className="mt-3 space-y-2">{pending.items.map(request => <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-fw-border p-3"><div className="min-w-0"><p className="text-sm font-medium">{request.requestedName || request.nodeType}</p><p className="text-xs text-fw-text-muted">{request.nodeType} · {request.connected ? 'Connected' : 'Offline'} · {new Date(request.requestedAt).toLocaleString()}</p><p className="break-all font-mono text-xs text-fw-text-muted">{request.id}</p></div><button type="button" disabled={!!approving} onClick={() => void approve(request)} className="rounded-lg bg-fw-accent px-3 py-1.5 text-sm font-medium text-fw-accent-text disabled:opacity-50">{approving === request.id ? 'Approving…' : 'Approve'}</button></div>)}</div>
          {!pending.items.length && !pending.total && !pending.error ? <p className="mt-3 text-sm text-fw-text-muted">No pending approvals.</p> : null}
          {pending.offset || pending.nextOffset !== null ? <div className="mt-3 flex items-center justify-between text-xs"><button type="button" disabled={!pending.offset} onClick={() => pending.setOffset(Math.max(0, pending.offset - 50))}>Previous</button><span>{pending.total} pending requests</span><button type="button" disabled={pending.nextOffset === null} onClick={() => pending.setOffset(pending.nextOffset || 0)}>Next</button></div> : null}
        </div>
      </section>
    </div>, document.body,
  )
}

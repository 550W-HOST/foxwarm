import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import type { WebUiNodeTarget } from '../nodeTargets'

type Launch = Record<string, string>
type Command = { baseUrl: string; launchInfo: Launch; command?: string; requiresToken: boolean; authToken?: string }
type Removal = { nodes: string[]; canDelete: boolean }
const methods = [
  ['bareMetal', 'Linux / macOS CLI'], ['bareMetalBackground', 'Linux / macOS background'],
  ['bareMetalInstall', 'Linux systemd'], ['windows', 'Windows CLI'],
  ['interactive', 'Interactive CLI'], ['docker', 'Docker'],
  ['shell', 'Linux Shell'], ['windowsShell', 'Windows Shell'],
]
const fieldClass = 'mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2 text-sm text-fw-text-strong'
const buttonClass = 'rounded-lg border border-fw-border px-3 py-2 text-sm hover:bg-fw-hover disabled:opacity-50'

export default function NodeActionsModal({ node, action, onClose, onNodesChanged }: {
  node: WebUiNodeTarget
  action: 'command' | 'delete'
  onClose: () => void
  onNodesChanged: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [address, setAddress] = useState('')
  const [launch, setLaunch] = useState<Launch>({})
  const [command, setCommand] = useState<Command | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [cascade, setCascade] = useState(false)
  const [confirmReissue, setConfirmReissue] = useState(false)
  const [copied, setCopied] = useState('')
  const endpoint = `${API_BASE_PATH}/nodes/${encodeURIComponent(node.id)}`
  const request = useCallback(async (suffix: string, method: string, body?: object) => {
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const response = await fetch(endpoint + suffix, {
        method, cache: 'no-store', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'The request could not be completed.')
      return result
    } finally { requests.current.delete(controller) }
  }, [endpoint])

  useEffect(() => {
    mounted.current = true
    const previousFocus = document.activeElement
    dialog.current?.showModal()
    const fallbackUrl = `${window.location.origin}${API_BASE_PATH.slice(0, -4)}`
    void (action === 'delete' ? request('/removal', 'GET') : request('/restart-command', 'POST', { fallbackUrl }))
      .then(result => {
        if (!mounted.current) return
        if (action === 'delete') setRemoval(result)
        else { setCommand(result); setLaunch(result.launchInfo); setAddress(result.baseUrl) }
      }).catch(failure => { if (mounted.current) setError(failure.message) })
      .finally(() => { if (mounted.current) setBusy(false) })
    return () => {
      mounted.current = false
      requests.current.forEach(controller => controller.abort())
      requests.current.clear()
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [action, request])

  const update = (key: string, value: string) => {
    setLaunch(current => ({ ...current, [key]: value }))
    setCommand(null); setCopied(''); setConfirmReissue(false)
  }
  const generate = async (reissue: boolean) => {
    setBusy(true); setError(''); setCopied('')
    try {
      const result = await request(reissue ? '/reissue-token' : '/restart-command', 'POST', { baseUrl: address, ...launch })
      if (mounted.current) {
        setCommand(result); setLaunch(result.launchInfo); setAddress(result.baseUrl); setConfirmReissue(false)
        if (reissue) await onNodesChanged()
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not load the command.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const remove = async () => {
    setBusy(true); setError('')
    try {
      await request(cascade ? '?cascade=true' : '', 'DELETE')
      await onNodesChanged()
      if (mounted.current) onClose()
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not delete this Node.') }
    finally { if (mounted.current) setBusy(false) }
  }
  const copy = async (text: string, kind: string) => {
    setError(''); setCopied('')
    try { await navigator.clipboard.writeText(text); if (mounted.current) setCopied(kind) }
    catch { if (mounted.current) setError('Copy failed. Select the text and copy it manually.') }
  }
  const shell = launch.method === 'shell' || launch.method === 'windowsShell'
  const issued = !!command?.authToken
  const extraPaths = launch.method === 'docker'
    ? [['stateDir', 'Data directory'], ['composeFile', 'Compose file'], ['envFile', 'Environment file']]
    : launch.method === 'windows' || launch.method === 'interactive'
      ? [['stateDir', 'Data directory'], ['sourceDir', 'Source directory']] : []

  return createPortal(<dialog ref={dialog} data-node-actions aria-labelledby="node-actions-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    className="m-auto max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-fw-border bg-fw-surface p-5 text-fw-text shadow-xl backdrop:bg-black/50">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0"><h2 id="node-actions-title" className="text-lg font-semibold text-fw-text-strong">{action === 'delete' ? 'Delete Node' : 'Start command'}</h2><p className="break-all font-mono text-sm text-fw-text-muted">{node.id}</p></div>
      <button type="button" aria-label="Close Node actions" onClick={onClose} className="rounded p-1 hover:bg-fw-hover"><X size={20} /></button>
    </div>
    {error ? <p role="alert" className="mb-3 text-sm text-fw-danger">{error}</p> : null}
    {busy ? <p role="status" className="mb-3 text-sm text-fw-text-muted">Loading…</p> : null}
    {action === 'delete' ? <div className="space-y-4">
      <p className="text-sm">Deleting revokes access and disconnects this Node. Processes and files on the remote machine are left untouched.</p>
      {removal && removal.nodes.length > 1 ? <>
        <p className="text-sm">These child Nodes will also be deleted:</p>
        <ul className="max-h-48 overflow-y-auto break-all font-mono text-xs">{removal.nodes.slice(1).map(id => <li key={id}>{id}</li>)}</ul>
        {removal.canDelete ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cascade} onChange={event => setCascade(event.target.checked)} />Delete this Node and all its child Nodes</label> : null}
      </> : null}
      {removal && !removal.canDelete ? <p className="text-sm text-fw-warning">This group includes Provider-managed Nodes. Remove those through their Provider first.</p> : null}
      <div className="flex justify-end gap-2"><button className={buttonClass} onClick={onClose}>Cancel</button><button className={`${buttonClass} text-fw-danger`} disabled={busy || !removal?.canDelete || (removal.nodes.length > 1 && !cascade)} onClick={() => void remove()}>Delete Node</button></div>
    </div> : <div className="space-y-4">
      <fieldset disabled={busy || issued} className="space-y-3 disabled:opacity-70">
        <label className="block text-sm">Launch method<select aria-label="Launch method" className={fieldClass} value={launch.method || ''} onChange={event => { setLaunch({ method: event.target.value, installDir: event.target.value === 'windows' ? 'C:\\foxwarm-node' : '/opt/foxwarm-node' }); setCommand(null); setCopied(''); setConfirmReissue(false) }}>{methods.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="block text-sm">Main server address<input aria-label="Main server address" className={fieldClass} value={address} onChange={event => { setAddress(event.target.value); setCommand(null); setConfirmReissue(false) }} /></label>
        {!shell ? <label className="block text-sm">Installation directory<input aria-label="Installation directory" className={fieldClass} value={launch.installDir || ''} onChange={event => update('installDir', event.target.value)} /></label> : null}
        {launch.method === 'bareMetalInstall' ? <label className="block text-sm">Service scope<select aria-label="Service scope" className={fieldClass} value={launch.serviceScope || 'user'} onChange={event => update('serviceScope', event.target.value)}><option value="user">Current user</option><option value="system">System</option></select></label> : null}
        {extraPaths.length ? <details><summary className="cursor-pointer text-sm text-fw-text-muted">Custom paths</summary>{extraPaths.map(([key, label]) => <label key={key} className="mt-2 block text-sm">{label}<input aria-label={label} className={fieldClass} value={launch[key] || ''} placeholder="Launcher default" onChange={event => update(key, event.target.value)} /></label>)}</details> : null}
        {!command ? <button type="button" className={buttonClass} onClick={() => void generate(false)}>Update command</button> : null}
      </fieldset>
      {command?.command ? <>
        <p className="text-sm text-fw-text-muted">Check the launch method and paths. Run this on the Node’s machine as the original user.{launch.serviceScope === 'system' ? ' Run it with permission to manage system services.' : ''}</p>
        {issued ? <p className="text-sm text-fw-warning">The old token no longer works. Copy this command now; the new token won't be shown again.</p> : null}
        <pre data-node-start-command className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-fw-canvas p-3 text-xs">{command.command}</pre>
        <button type="button" className={buttonClass} onClick={() => void copy(command.command!, 'command')}>{copied === 'command' ? 'Copied' : 'Copy command'}</button>
        {issued ? <div><label className="block text-sm">New token<input aria-label="New Node token" readOnly className={`${fieldClass} font-mono`} value={command.authToken} /></label><button type="button" className={`${buttonClass} mt-2`} onClick={() => void copy(command.authToken!, 'token')}>{copied === 'token' ? 'Copied' : 'Copy token'}</button></div> : null}
      </> : shell ? <p className="text-sm text-fw-text-muted">Reissue a token to create a new Shell start command.</p> : null}
      {!issued ? <div className="border-t border-fw-border pt-3">
        {confirmReissue ? <><p className="mb-3 text-sm">Reissue the token for {node.id}? The old token will stop working and any current connection will be disconnected.</p><div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => setConfirmReissue(false)}>Cancel</button><button className={`${buttonClass} text-fw-danger`} disabled={busy} onClick={() => void generate(true)}>Reissue and show command</button></div></>
          : <><p className="mb-2 text-sm text-fw-text-muted">{shell ? 'A new token replaces the previous one.' : 'Lost the saved credentials? Reissue a token to reconnect.'}</p><button className={buttonClass} disabled={busy || !command} onClick={() => setConfirmReissue(true)}>Reissue token</button></>}
      </div> : null}
    </div>}
  </dialog>, document.body)
}

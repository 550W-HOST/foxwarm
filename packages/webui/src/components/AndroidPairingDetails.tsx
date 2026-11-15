import { useEffect, useState } from 'react'
import NodeSetupQr from './NodeSetupQr'

type Pairing = { type: string; version: number; baseUrl: string; nodeId: string; authToken: string }

/** Credential display belongs only to the mounted onboarding dialog. */
export default function AndroidPairingDetails({ pairing }: { pairing: Pairing }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setError(''); setCopied(false)
  }, [pairing])
  return <div className="mt-4 space-y-3" data-android-pairing>
    <NodeSetupQr value={JSON.stringify(pairing)} alt="Scan to connect this Android Node" failure="Could not create the QR code. Enter the fields manually." />
    <label className="block text-xs font-medium">Credential<input aria-label="Android credential" readOnly value={pairing.authToken} className="mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2 font-mono text-sm text-fw-text-strong" /></label>
    <button type="button" className="text-sm font-medium text-fw-accent" onClick={() => {
      setError('')
      void navigator.clipboard.writeText(pairing.authToken).then(() => setCopied(true)).catch(() => setError('Copy failed. Select the credential and copy it manually.'))
    }}>{copied ? 'Copied' : 'Copy credential'}</button>
    {error ? <p role="alert" className="text-sm text-fw-danger">{error}</p> : null}
  </div>
}

import { useEffect, useState } from 'react'

type Pairing = { type: string; version: number; baseUrl: string; nodeId: string; authToken: string }

/** Credential display belongs only to the mounted onboarding dialog. */
export default function AndroidPairingDetails({ pairing }: { pairing: Pairing }) {
  const [qr, setQr] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let active = true
    setQr(''); setError(''); setCopied(false)
    void import('qrcode').then(module => module.toDataURL(JSON.stringify(pairing), { width: 320, margin: 4, errorCorrectionLevel: 'M' }))
      .then(image => { if (active) setQr(image) })
      .catch(() => { if (active) setError('Could not create the QR code. Enter the fields manually.') })
    return () => { active = false }
  }, [pairing])
  return <div className="mt-4 space-y-3" data-android-pairing>
    {qr ? <img src={qr} alt="Scan to connect this Android Node" className="mx-auto h-auto w-80 max-w-full rounded-lg" /> : null}
    <label className="block text-xs font-medium">Credential<input aria-label="Android credential" readOnly value={pairing.authToken} className="mt-1 w-full rounded-lg border border-fw-border bg-fw-canvas px-3 py-2 font-mono text-sm text-fw-text-strong" /></label>
    <button type="button" className="text-sm font-medium text-fw-accent" onClick={() => {
      setError('')
      void navigator.clipboard.writeText(pairing.authToken).then(() => setCopied(true)).catch(() => setError('Copy failed. Select the credential and copy it manually.'))
    }}>{copied ? 'Copied' : 'Copy credential'}</button>
    {error ? <p role="alert" className="text-sm text-fw-danger">{error}</p> : null}
  </div>
}

import { useEffect, useState } from 'react'

/** Local QR rendering shared by app download and mounted pairing details. */
export default function NodeSetupQr({ value, alt, failure }: { value: string; alt: string; failure: string }) {
  const [qr, setQr] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setQr(''); setFailed(false)
    void import('qrcode').then(module => module.toDataURL(value, { width: 320, margin: 4, errorCorrectionLevel: 'M' }))
      .then(image => { if (active) setQr(image) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [value])
  return <>
    {qr ? <img src={qr} alt={alt} className="mx-auto h-auto w-80 max-w-full rounded-lg" /> : null}
    {failed ? <p role="alert" className="text-sm text-fw-danger">{failure}</p> : null}
  </>
}

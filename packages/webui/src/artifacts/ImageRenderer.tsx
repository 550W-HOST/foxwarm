import { useMemo, useState } from 'react'
import type { StoredArtifact } from '../../../shared/src/artifacts/types'
import { validateImageDocument } from '../../../shared/src/artifacts/image'
import ImagePreviewDialog from '../components/ImagePreviewDialog'
import { artifactResourceUrl, downloadImageArtifact } from './downloads'
export default function ImageRenderer({ artifact }: { artifact: StoredArtifact }) {
  const doc = useMemo(() => validateImageDocument(artifact.document), [artifact.document])
  const [open, setOpen] = useState(false), [failed, setFailed] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState(false)
  const src = artifactResourceUrl(artifact.receipt, 'image')
  const download = async () => {
    setError(''); setPending(true)
    try { await downloadImageArtifact(artifact) } catch { setError('Image download unavailable') } finally { setPending(false) }
  }
  return <div className="artifact-image">
    {failed ? <p role="alert">Image unavailable</p> : <button className="artifact-image-preview" onClick={() => setOpen(true)} aria-label={`Preview ${doc.title}`}><img src={src} alt={doc.alt || doc.title} width={doc.width} height={doc.height} onError={() => setFailed(true)} /></button>}
    {open && <ImagePreviewDialog title={doc.title} mimeType={doc.mimeType} src={src} onClose={() => setOpen(false)} onDownload={() => { void download() }} downloadPending={pending} downloadError={error} />}
  </div>
}

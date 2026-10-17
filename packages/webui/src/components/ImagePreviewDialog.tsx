import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { requestImageDownloadUrl, triggerBrowserDownload } from './downloadShared'

const raster = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const isSafeImagePreviewMime = (mimeType: unknown) => typeof mimeType === 'string' && raster.has(mimeType.toLowerCase())

let scrollLocks = 0
let savedOverflow = { root: '', body: '' }
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    savedOverflow = { root: document.documentElement.style.overflow, body: document.body.style.overflow }
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
  }
  return () => {
    if (--scrollLocks === 0) {
      document.documentElement.style.overflow = savedOverflow.root
      document.body.style.overflow = savedOverflow.body
    }
  }
}

interface Props {
  src: string
  mimeType: string
  title: string
  onClose: () => void
  onDownload?: () => void
  downloadPending?: boolean
  downloadError?: string
}

function Preview({ src, mimeType, title, onClose, onDownload, downloadPending, downloadError }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const titleId = useId()
  const [failed, setFailed] = useState(!isSafeImagePreviewMime(mimeType))
  const [loaded, setLoaded] = useState(false)
  const [actualSize, setActualSize] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const unlock = lockPageScroll()
    dialog?.showModal()
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      requestRef.current?.abort()
      dialog?.close()
      unlock()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  const download = async () => {
    if (onDownload) { onDownload(); return }
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    setPending(true); setError('')
    try {
      const downloadUrl = /^(?:blob:|data:)/i.test(src) ? src : await requestImageDownloadUrl(src, title, controller.signal)
      if (!controller.signal.aborted) triggerBrowserDownload(downloadUrl, title)
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === 'Image unavailable' ? 'Image unavailable' : 'Download unavailable')
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }
  return createPortal(<dialog ref={dialogRef} data-image-preview className="image-preview-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => event.stopPropagation()}>
    <header className="image-preview-header">
      <h2 id={titleId} title={title}>{title}</h2>
      <button type="button" className="image-preview-action" disabled={failed || !loaded} aria-label={actualSize ? 'Fit image' : 'Actual size'} aria-pressed={actualSize} title={actualSize ? 'Fit image' : 'Actual size'} onClick={() => setActualSize(value => !value)}>{actualSize ? <ZoomOut size={20} /> : <ZoomIn size={20} />}</button>
      <button type="button" className="image-preview-action" disabled={downloadPending || pending} aria-label={`Download ${title}`} title="Download" onClick={() => { void download() }}><Download size={20} /></button>
      <button ref={closeRef} type="button" className="image-preview-action" aria-label="Close image preview" title="Close" onClick={onClose}><X size={22} /></button>
    </header>
    <div ref={stageRef} className="image-preview-stage" data-actual-size={actualSize || undefined} tabIndex={0} aria-label="Image preview" onClick={event => { if (!actualSize && event.target === event.currentTarget) onClose() }}>
      {failed ? <span role="status">Image unavailable</span> : <>
        {!loaded && <span role="status" className="image-preview-loading">Loading image…</span>}
        <img src={src} alt={title} draggable={false} onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false) }} onClick={() => { setActualSize(value => !value); stageRef.current?.focus({ preventScroll: true }) }} />
      </>}
    </div>
    {(downloadError || error) && <div role="alert" className="image-preview-error">{downloadError || error}</div>}
  </dialog>, document.body)
}

export default function ImagePreviewDialog(props: Props) {
  return <Preview key={`${props.mimeType}:${props.src}`} {...props} />
}

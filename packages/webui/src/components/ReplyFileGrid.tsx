import { useEffect, useRef, useState } from 'react'
import { Download, File, Image as ImageIcon } from 'lucide-react'
import { buildPathDownloadUrl, requestPathDownloadUrl, triggerBrowserDownload } from './downloadShared'
import type { ReplyFile } from './replyFiles'
import ImagePreviewDialog, { isSafeImagePreviewMime } from './ImagePreviewDialog'

const sizeLabel = (size?: number) => size === undefined ? '' : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

function ReplyFileTile({ file }: { file: ReplyFile }) {
  const [preview, setPreview] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)
  const image = isSafeImagePreviewMime(file.mimeType)
  const url = buildPathDownloadUrl(file.downloadPath, { fileName: file.fileName })
  const previewUrl = buildPathDownloadUrl(file.downloadPath, { fileName: file.fileName, preview: true })
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])
  const download = async () => {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setPending(true); setError('')
    try {
      const signedUrl = await requestPathDownloadUrl(url, controller.signal)
      if (mounted.current && !controller.signal.aborted) triggerBrowserDownload(signedUrl, file.fileName)
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(err instanceof Error && err.message === 'File unavailable' ? 'File unavailable' : 'Download unavailable')
    } finally {
      if (request.current === controller) request.current = null
      if (mounted.current && !controller.signal.aborted) setPending(false)
    }
  }
  const type = file.fileName.split('.').length > 1 ? file.fileName.split('.').at(-1)!.slice(0, 8).toUpperCase() : 'File'
  const Icon = image ? ImageIcon : File
  return <div role="listitem" className="reply-file-tile" data-delivery-id={file.deliveryId}>
    <button type="button" className="reply-file-main" disabled={!image && pending} title={file.fileName} aria-label={`${image ? 'Preview' : 'Download'} ${file.fileName}`} onClick={() => { if (image) setPreview(true); else void download() }}>
      <span className="reply-file-thumbnail">{image && (file.sizeBytes === undefined || file.sizeBytes <= 8 * 1024 * 1024) && !previewFailed ? <img src={previewUrl} alt="" loading="lazy" onError={() => setPreviewFailed(true)} /> : <Icon size={28} className="text-fw-text-muted" />}</span>
      <span className="block truncate px-2 pt-1 text-xs text-fw-text-strong">{file.fileName}</span>
      <span className="block truncate px-2 pb-1.5 pt-0.5 text-[11px] text-fw-text-muted">{[type, sizeLabel(file.sizeBytes)].filter(Boolean).join(' · ')}</span>
    </button>
    {image ? <button type="button" disabled={pending} className="reply-file-download reply-file-icon-button" aria-label={`Download ${file.fileName}`} onClick={() => { void download() }}><Download size={15} /></button> : <Download size={14} className="pointer-events-none absolute right-2 top-2 text-fw-text-muted" aria-hidden="true" />}
    {error && <div role="alert" className="px-2 pb-2 text-[11px] text-fw-warning">{error}</div>}
    {preview && <ImagePreviewDialog title={file.fileName} mimeType={file.mimeType} src={previewUrl} downloadError={error} downloadPending={pending} onDownload={() => { void download() }} onClose={() => setPreview(false)} />}
  </div>
}

export default function ReplyFileGrid({ files }: { files: readonly ReplyFile[] }) {
  if (!files.length) return null
  return <div role="list" aria-label="Reply files" data-reply-files className="reply-file-grid">{files.map(file => <ReplyFileTile key={file.deliveryId} file={file} />)}</div>
}

import { useEffect, useState } from 'react'
import { File, Image, X } from 'lucide-react'
import type { ComposerAttachmentSegment } from '../composerDraft'
import { isSafeImagePreviewMime } from './ImagePreviewDialog'

interface AttachmentTileProps {
  attachment: ComposerAttachmentSegment
  file?: File
  number: number
  disabled: boolean
  onOpen: () => void
  onRemove: () => void
}

function AttachmentTile({ attachment, file, number, disabled, onOpen, onRemove }: AttachmentTileProps) {
  const image = isSafeImagePreviewMime(attachment.mimeType)
  const [preview, setPreview] = useState<{ file: File; url: string }>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!file || !image) { setPreview(undefined); return }
    const url = URL.createObjectURL(file)
    setPreview({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file, image])
  const src = preview?.file === file ? preview?.url : undefined
  const Icon = image ? Image : File
  return <div role="listitem" data-attachment-preview-ref={attachment.ref} className="composer-attachment-tile">
    <button type="button" disabled={disabled} onClick={onOpen}
      aria-label={`Preview attachment ${number}: ${attachment.name}${file ? '' : ', reattach required'}`}
      title={`${attachment.name} · ${attachment.mimeType} · ${attachment.size.toLocaleString()} B`}
      className="composer-attachment-preview">
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <Icon size={26} aria-hidden="true" className="text-fw-text-muted" />}
      <span aria-hidden="true" data-attachment-number className="composer-attachment-number">{number}</span>
      <span className="composer-attachment-filename">{attachment.name}</span>
      {!file && <span className="composer-attachment-missing">Reattach</span>}
    </button>
    <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Remove attachment ${attachment.name}`}
      className="composer-attachment-remove"><X size={14} aria-hidden="true" /></button>
  </div>
}

export default function ComposerAttachmentGrid({ attachments, resolveFile, disabled, onOpen, onRemove }: {
  attachments: readonly ComposerAttachmentSegment[]
  resolveFile: (ref: string) => File | undefined
  disabled: boolean
  onOpen: (ref: string) => void
  onRemove: (ref: string) => void
}) {
  if (!attachments.length) return null
  return <div role="list" aria-label="Attachments" className="composer-attachment-grid">
    {attachments.map((attachment, index) => <AttachmentTile key={attachment.ref}
      attachment={attachment} file={resolveFile(attachment.ref)} number={index + 1} disabled={disabled}
      onOpen={() => onOpen(attachment.ref)} onRemove={() => onRemove(attachment.ref)} />)}
  </div>
}

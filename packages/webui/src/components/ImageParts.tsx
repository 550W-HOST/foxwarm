import { createContext, memo, useContext, useState } from 'react'
import type { MessagePart } from './chatShared'
import { makeApiUrl } from '../config'
import ImagePreviewDialog, { isSafeImagePreviewMime } from './ImagePreviewDialog'

export const WebUiImageSessionContext = createContext<string | null>(null)

export function ImageItem({ part, label, imageClassName = 'max-w-[300px] max-h-[200px]' }: { part: MessagePart; label: string; imageClassName?: string }) {
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState(false)
  const webUiSessionId = useContext(WebUiImageSessionContext)
  const mimeType = part.inlineDataRef?.mimeType
    || part.inlineData?.mimeType
    || part.inlineDataUnavailable?.mimeType
    || part.inlineDataUnavailable?.mime_type
    || 'application/octet-stream'
  const src = part.inlineDataRef?.apiPath
    ? makeApiUrl(webUiSessionId && part.inlineDataRef.blobId
      ? `/sessions/${encodeURIComponent(webUiSessionId)}/blobs/${encodeURIComponent(part.inlineDataRef.blobId)}`
      : part.inlineDataRef.apiPath).toString()
    : part.inlineData
      ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      : null

  if (!src || failed) {
    return <div className="text-xs text-fw-text-muted">Image unavailable</div>
  }
  if (!isSafeImagePreviewMime(mimeType)) {
    return (
      <a className="text-xs text-fw-accent dark:text-fw-accent underline" href={src} download={label} rel="noopener noreferrer">
        Download image attachment
      </a>
    )
  }

  return (
    <>
      <button
        type="button"
        className="foxwarm-image-item relative cursor-pointer text-left"
        aria-label={`Open ${label}`}
        onClick={() => setPreview(true)}
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => setFailed(true)}
          className={`${imageClassName} rounded-lg border border-fw-border-strong hover:opacity-90 transition`}
        />
        <div className="foxwarm-image-hover-overlay absolute inset-0 bg-fw-overlay/0 transition rounded-lg pointer-events-none" />
      </button>
      {preview && <ImagePreviewDialog src={src} mimeType={mimeType} title={label} onClose={() => setPreview(false)} />}
    </>
  )
}

const ImageParts = memo(function ImageParts({ imageParts, keyPrefix }: { imageParts: MessagePart[]; keyPrefix: string }) {
  if (imageParts.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {imageParts.map((part, idx) => {
        return (
          <ImageItem key={`${keyPrefix}-${part.inlineDataRef?.blobId || idx}`} part={part} label={`Image ${idx + 1}`} />
        )
      })}
    </div>
  )
})

export default ImageParts

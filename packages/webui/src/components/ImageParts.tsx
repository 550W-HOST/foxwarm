import { memo, useState } from 'react'
import type { MessagePart } from './chatShared'
import { makeApiUrl } from '../config'

const SAFE_RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function ImageItem({ part, label }: { part: MessagePart; label: string }) {
  const [failed, setFailed] = useState(false)
  const mimeType = part.inlineDataRef?.mimeType
    || part.inlineData?.mimeType
    || part.inlineDataUnavailable?.mimeType
    || part.inlineDataUnavailable?.mime_type
    || 'application/octet-stream'
  const src = part.inlineDataRef?.apiPath
    ? makeApiUrl(part.inlineDataRef.apiPath).toString()
    : part.inlineData
      ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      : null

  if (!src || failed) {
    return <div className="text-xs text-fw-text-muted">Image unavailable</div>
  }
  if (!SAFE_RASTER_MIME_TYPES.has(mimeType)) {
    return (
      <a className="text-xs text-fw-accent dark:text-fw-accent underline" href={src} target="_blank" rel="noopener noreferrer">
        Download image attachment
      </a>
    )
  }

  return (
    <div className="relative group cursor-pointer" onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}>
      <img
        src={src}
        alt={label}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-w-[300px] max-h-[200px] rounded-lg border border-fw-border-strong hover:opacity-90 transition"
      />
      <div className="absolute inset-0 bg-fw-overlay/0 group-hover:bg-fw-overlay/10 transition rounded-lg pointer-events-none" />
    </div>
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

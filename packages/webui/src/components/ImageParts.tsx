import { memo } from 'react'
import type { MessagePart } from './chatShared'

const ImageParts = memo(function ImageParts({ imageParts, keyPrefix }: { imageParts: MessagePart[]; keyPrefix: string }) {
  if (imageParts.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {imageParts.map((part, idx) => {
        const { data, mimeType } = part.inlineData!
        const src = `data:${mimeType};base64,${data}`
        return (
          <div key={`${keyPrefix}-${idx}`} className="relative group cursor-pointer" onClick={() => window.open(src, '_blank')}>
            <img
              src={src}
              alt={`Image ${idx + 1}`}
              className="max-w-[300px] max-h-[200px] rounded-lg border border-gray-200 dark:border-gray-600 hover:opacity-90 transition"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition rounded-lg pointer-events-none" />
          </div>
        )
      })}
    </div>
  )
})

export default ImageParts

import { ArtifactDocument, baseDocument, keys, text } from './types'
export const IMAGE_ARTIFACT_MAX_BYTES = 12 * 1024 * 1024
export const IMAGE_ARTIFACT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export interface ImageDocument extends ArtifactDocument {
  type: 'image'; schemaVersion: 1; mimeType: typeof IMAGE_ARTIFACT_MIME_TYPES[number]; width: number; height: number; alt?: string
}
export function validateImageDocument(value: unknown): ImageDocument {
  const v = baseDocument(value, 'image')
  keys(v, ['type','schemaVersion','title','description','mimeType','width','height','alt'], 'Image')
  if (!(IMAGE_ARTIFACT_MIME_TYPES as readonly unknown[]).includes(v.mimeType)) throw new Error('Only PNG, JPEG, GIF and WebP images are supported')
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.height < 1 || v.width * v.height > 40000000) throw new Error('Image dimensions exceed 40 megapixels')
  if (v.alt !== undefined) text(v.alt, 'alt', 1000)
  return JSON.parse(JSON.stringify(v))
}

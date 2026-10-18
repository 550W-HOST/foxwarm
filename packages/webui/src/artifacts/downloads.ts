import { makeApiUrl } from '../config'
import type { ArtifactReceipt, StoredArtifact } from '../../../shared/src/artifacts/types'
export function artifactResourceUrl(receipt: ArtifactReceipt, resource: string) {
  return makeApiUrl(`/sessions/${encodeURIComponent(receipt.sessionId)}/artifacts/${receipt.artifactId}/${receipt.revision}/resources/${encodeURIComponent(resource)}`).toString()
}
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function downloadManifest(artifact: StoredArtifact) {
  save(new Blob([JSON.stringify(artifact.document, null, 2)], { type: 'application/json' }), `${artifact.receipt.artifactId}-r${artifact.receipt.revision}.json`)
}
export async function downloadImageArtifact(artifact: StoredArtifact) {
  const response = await fetch(artifactResourceUrl(artifact.receipt, 'image'))
  if (!response.ok) throw new Error('Image unavailable')
  const mime = artifact.resources?.image.mimeType
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mime || '']
  if (!extension || response.headers.get('content-type')?.split(';')[0] !== mime) throw new Error('Invalid image response')
  save(await response.blob(), `${artifact.receipt.artifactId}-r${artifact.receipt.revision}.${extension}`)
}

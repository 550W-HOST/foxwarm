import { ArtifactDocument, MAX_ARTIFACT_BYTES, object } from './types'
import { validateChartDocument } from './chart'
import { validateImageDocument } from './image'
import { validateReactDocument } from './react'
export const artifactModules: Readonly<Record<string, { schemaVersion: number; validate: (value: unknown) => ArtifactDocument }>> = Object.freeze({
  image: { schemaVersion: 1, validate: validateImageDocument },
  chart: { schemaVersion: 1, validate: validateChartDocument },
  react: { schemaVersion: 1, validate: validateReactDocument },
})
export function validateArtifactDocument(value: unknown): ArtifactDocument {
  const v = object(value, 'Artifact')
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds 2 MiB')
  const module = Object.prototype.hasOwnProperty.call(artifactModules, v.type) && artifactModules[v.type]
  if (!module) throw new Error('Unsupported artifact type')
  return module.validate(v)
}

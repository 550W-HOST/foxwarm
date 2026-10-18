/** The envelope protocol, module format and immutable revision are independent. */
export interface ArtifactReceipt {
  protocolVersion: 1
  artifactId: string
  revision: number
  sessionId: string
  type: string
  title: string
}
export interface ArtifactDocument { type: string; schemaVersion: number; title: string; description?: string }
export interface StoredArtifact {
  receipt: ArtifactReceipt
  createdAt: string
  document: ArtifactDocument
  compiled?: string
  resources?: Record<string, { mimeType: string; sizeBytes: number; sha256: string }>
}
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
export function parseArtifactReceipt(value: unknown): ArtifactReceipt | undefined {
  const v = value as ArtifactReceipt
  if (!v || v.protocolVersion !== 1 || !/^art_[a-f0-9]{32}$/.test(v.artifactId || '') || !Number.isSafeInteger(v.revision) || v.revision < 1
    || typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 256
    || typeof v.type !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v.type)
    || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) return
  return { protocolVersion: 1, artifactId: v.artifactId, revision: v.revision, sessionId: v.sessionId, type: v.type, title: v.title }
}
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, any>
}
export function keys(value: object, allowed: string[], label: string) {
  const bad = Object.keys(value).find(k => !allowed.includes(k))
  if (bad) throw new Error(`${label}: unsupported field ${bad}`)
}
export function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text, at most ${max} characters`)
  return value
}
export function baseDocument(value: unknown, type: string): Record<string, any> {
  const v = object(value, 'Artifact')
  if (v.type !== type || v.schemaVersion !== 1) throw new Error(`Expected ${type} schemaVersion 1`)
  text(v.title, 'title'); if (v.description !== undefined) text(v.description, 'description', 1000)
  return v
}

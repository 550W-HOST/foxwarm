export interface ArtifactReference { artifactId: string; revision: number }
/** A reference selects a persisted revision; it never grants access. */
export function parseArtifactMarker(line: string): ArtifactReference | undefined {
  const match = /^<foxwarm-artifact[\t ]+id="(art_[a-f0-9]{32})"[\t ]+revision="([1-9]\d{0,15})"[\t ]*\/>[\t ]*\r?$/.exec(line)
    || /^<foxwarm-artifact[\t ]+revision="([1-9]\d{0,15})"[\t ]+id="(art_[a-f0-9]{32})"[\t ]*\/>[\t ]*\r?$/.exec(line)
  if (!match) return
  const revision = Number(match[1].startsWith('art_') ? match[2] : match[1])
  if (!Number.isSafeInteger(revision)) return
  return match[1].startsWith('art_') ? { artifactId: match[1], revision: Number(match[2]) } : { artifactId: match[2], revision: Number(match[1]) }
}
export function formatArtifactMarker(ref: ArtifactReference): string {
  const marker = `<foxwarm-artifact id="${ref.artifactId}" revision="${ref.revision}" />`
  if (!parseArtifactMarker(marker)) throw new Error('Invalid artifact reference')
  return marker
}

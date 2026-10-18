import { ArtifactDocument, baseDocument, keys, object } from './types'
export interface ReactDocument extends ArtifactDocument {
  type: 'react'; schemaVersion: 1; entry: string; files: Record<string, string>
}
export function validateReactDocument(value: unknown): ReactDocument {
  const v = baseDocument(value, 'react'); keys(v, ['type', 'schemaVersion', 'title', 'description', 'entry', 'files'], 'React artifact')
  object(v.files, 'files')
  const names = Object.keys(v.files)
  if (!names.length || names.length > 24 || typeof v.entry !== 'string' || !names.includes(v.entry) || !/\.[jt]sx?$/.test(v.entry)) throw new Error('Expected an entry and 1–24 source files')
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:tsx?|jsx?|css|json)$/.test(name) || name.length > 160
      || typeof v.files[name] !== 'string' || v.files[name].length > 200000) throw new Error('Invalid source filename or oversized file')
  }
  return JSON.parse(JSON.stringify(v))
}

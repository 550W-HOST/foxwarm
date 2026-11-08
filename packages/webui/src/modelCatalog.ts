import { isMap, isScalar, parseDocument } from 'yaml'

/**
 * The advisory model catalog of models YAML: an ordered `catalog` map from a selectable model key
 * to a short description. The editor reads and writes it directly in the YAML text, which stays the
 * only storage, so comments and the rest of the document are kept.
 */

export type ModelCatalogRow = { key: string; description: string }

export type ModelCatalogReading =
  | { ok: true; rows: ModelCatalogRow[] }
  | { ok: false }

/** Reads catalog rows in document order. Invalid YAML or an unusable catalog is not editable here. */
export function readModelCatalog(text: string): ModelCatalogReading {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return { ok: false }
  if (doc.contents === null) return { ok: true, rows: [] }
  if (!isMap(doc.contents)) return { ok: false }
  const node = doc.get('catalog', true)
  if (node === undefined || node === null) return { ok: true, rows: [] }
  if (isScalar(node) && node.value === null) return { ok: true, rows: [] }
  if (!isMap(node)) return { ok: false }
  const rows: ModelCatalogRow[] = []
  const seen = new Set<string>()
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : null
    const value = isScalar(pair.value) ? pair.value.value : null
    if (typeof key !== 'string' || seen.has(key)) return { ok: false }
    if (value !== null && typeof value !== 'string') return { ok: false }
    seen.add(key)
    rows.push({ key, description: value ?? '' })
  }
  return { ok: true, rows }
}

/**
 * Replaces the catalog in the YAML text, or removes it when there are no rows. Other content keeps
 * its comments and order; returns the text unchanged when it cannot be edited safely.
 */
export function writeModelCatalog(text: string, rows: readonly ModelCatalogRow[]): string {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return text
  if (doc.contents !== null && !isMap(doc.contents)) return text
  if (rows.length === 0) {
    if (!doc.has('catalog')) return text
    doc.delete('catalog')
  } else {
    if (new Set(rows.map((row) => row.key)).size !== rows.length) return text
    doc.set('catalog', doc.createNode(new Map(rows.map((row) => [row.key, row.description]))))
  }
  return doc.toString({ lineWidth: 0 })
}

export function addCatalogRow(rows: readonly ModelCatalogRow[], keys: readonly string[]): ModelCatalogRow[] {
  const used = new Set(rows.map((row) => row.key))
  const key = keys.find((candidate) => !used.has(candidate))
  return key === undefined ? [...rows] : [...rows, { key, description: '' }]
}

export function moveCatalogRow(rows: readonly ModelCatalogRow[], index: number, offset: -1 | 1): ModelCatalogRow[] {
  const target = index + offset
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return [...rows]
  const next = [...rows]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

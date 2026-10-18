import { ArtifactDocument, baseDocument, keys, object, text } from './types'
export interface ChartDocument extends ArtifactDocument {
  type: 'chart'; schemaVersion: 1
  data: Record<string, string | number | boolean | null>[]
  spec: Record<string, any>
  source?: string
  controls?: { recent?: number; smoothing?: { field: string; as: string; window: number } }
  metrics?: { label: string; field: string; aggregate: 'last' | 'mean'; window?: number; percent?: boolean }[]
}
// Closed declarative subset: no URL loaders, expressions, authored signals or transforms.
const SPEC_KEYS = ['mark', 'encoding', 'layer', 'name', 'title', 'width', 'height']
const CHANNELS = ['x', 'y', 'x2', 'y2', 'color', 'size', 'shape', 'opacity', 'tooltip', 'detail', 'order']
const FIELD_KEYS = ['field', 'type', 'title', 'aggregate', 'bin', 'timeUnit', 'scale', 'axis', 'legend', 'sort', 'value']
const scalar = (v: unknown) => v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)
function field(v: any, known: Set<string>) {
  object(v, 'encoding'); keys(v, FIELD_KEYS, 'encoding')
  if (v.field !== undefined && (typeof v.field !== 'string' || !known.has(v.field))) throw new Error('Encoding refers to an unknown field')
  if (v.type !== undefined && !['quantitative', 'temporal', 'ordinal', 'nominal'].includes(v.type)) throw new Error('Unsupported field type')
  if (v.aggregate !== undefined && !['mean', 'sum', 'min', 'max', 'count', 'median'].includes(v.aggregate)) throw new Error('Unsupported aggregate')
  if (v.bin !== undefined && typeof v.bin !== 'boolean') throw new Error('bin must be boolean')
  if (v.timeUnit !== undefined && !['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'yearmonthdate'].includes(v.timeUnit)) throw new Error('Unsupported timeUnit')
  for (const k of ['title', 'value', 'sort']) if (v[k] !== undefined && !scalar(v[k])) throw new Error(`Invalid ${k}`)
  if (typeof v.value === 'string' && /url\s*\(|javascript:|https?:|data:/i.test(v.value)) throw new Error('External encoding values are not allowed')
  if (v.sort !== undefined && !['ascending', 'descending', null].includes(v.sort)) throw new Error('Unsupported sort')
  for (const [k, allowed] of Object.entries({ scale: ['zero', 'domain', 'range', 'type', 'nice'], axis: ['title', 'format', 'tickCount', 'labelAngle', 'grid'], legend: ['title', 'orient'] })) {
    if (v[k] === undefined || v[k] === null) continue
    object(v[k], k); keys(v[k], allowed, k)
    if (k === 'scale' && Array.isArray(v[k].range) && v[k].range.some((x: unknown) => typeof x === 'string' && /url\s*\(|https?:|data:/i.test(x))) throw new Error('External scale values are not allowed')
    for (const x of Object.values(v[k])) if (!(scalar(x) || Array.isArray(x) && x.length <= 64 && x.every(scalar))) throw new Error(`Invalid ${k} option`)
  }
}
function spec(v: any, known: Set<string>, depth = 0) {
  object(v, 'spec'); keys(v, SPEC_KEYS, 'spec')
  if (depth > 1) throw new Error('Nested layers are not supported')
  if (v.name !== undefined) { text(v.name, 'layer name', 60); if (!/^[a-zA-Z][\w-]*$/.test(v.name)) throw new Error('Invalid layer name') }
  if (v.title !== undefined) text(v.title, 'chart title')
  if (v.width !== undefined && v.width !== 'container') throw new Error('Chart width must be container')
  if (v.height !== undefined && (!Number.isInteger(v.height) || v.height < 160 || v.height > 640)) throw new Error('Chart height must be 160–640')
  if (v.mark !== undefined) {
    const mark = typeof v.mark === 'string' ? { type: v.mark } : object(v.mark, 'mark')
    keys(mark, ['type', 'color', 'opacity', 'strokeWidth', 'point', 'interpolate'], 'mark')
    if (!['line', 'area', 'bar', 'point', 'circle', 'rect', 'rule', 'tick'].includes(mark.type)) throw new Error('Unsupported mark')
    for (const x of Object.values(mark)) if (!scalar(x)) throw new Error('Invalid mark option')
    if (mark.color !== undefined && (typeof mark.color !== 'string' || !/^#[a-fA-F0-9]{3,8}$/.test(mark.color))) throw new Error('Mark colors must be hexadecimal')
    if (mark.interpolate !== undefined && !['linear', 'step', 'step-before', 'step-after', 'monotone'].includes(mark.interpolate)) throw new Error('Unsupported interpolation')
  }
  if (v.encoding !== undefined) {
    object(v.encoding, 'encoding'); keys(v.encoding, CHANNELS, 'encoding')
    for (const [k, x] of Object.entries(v.encoding)) {
      if (k === 'tooltip' && Array.isArray(x)) { if (x.length > 12) throw new Error('Too many tooltip fields'); x.forEach(x => field(x, known)) }
      else field(x, known)
    }
  }
  if (v.layer !== undefined) {
    if (v.mark !== undefined || !Array.isArray(v.layer) || !v.layer.length || v.layer.length > 8) throw new Error('Expected 1–8 layers without top-level mark')
    v.layer.forEach((x: any) => spec(x, known, depth + 1))
    const names = v.layer.map((x: any) => x.name).filter(Boolean)
    if (new Set(names).size !== names.length) throw new Error('Layer names must be unique')
  } else if (v.mark === undefined) throw new Error('A mark or layers are required')
}
export function validateChartDocument(value: unknown): ChartDocument {
  const v = baseDocument(value, 'chart'); keys(v, ['type', 'schemaVersion', 'title', 'description', 'data', 'spec', 'source', 'controls', 'metrics'], 'Chart')
  if (!Array.isArray(v.data) || !v.data.length || v.data.length > 20000) throw new Error('Expected 1–20000 data rows; aggregate larger datasets first')
  const known = new Set<string>()
  for (const row of v.data) {
    object(row, 'data row'); if (Object.keys(row).length > 32) throw new Error('At most 32 fields per row')
    for (const [k, x] of Object.entries(row)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) || ['constructor', 'prototype', '__proto__'].includes(k) || !scalar(x) || typeof x === 'string' && x.length > 500) throw new Error('Invalid data field or value')
      known.add(k)
    }
  }
  if (known.size > 32) throw new Error('At most 32 data fields')
  if (v.source !== undefined) text(v.source, 'source', 500)
  if (v.controls !== undefined) {
    object(v.controls, 'controls'); keys(v.controls, ['recent', 'smoothing'], 'controls')
    if (v.controls.recent !== undefined && (!Number.isInteger(v.controls.recent) || v.controls.recent < 2 || v.controls.recent > 20000)) throw new Error('Invalid recent row count')
    if (v.controls.smoothing) {
      const s = object(v.controls.smoothing, 'smoothing'); keys(s, ['field', 'as', 'window'], 'smoothing')
      if (!known.has(s.field) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(s.as) || known.has(s.as) || ['constructor', 'prototype'].includes(s.as) || !Number.isInteger(s.window) || s.window < 1 || s.window > 200) throw new Error('Invalid smoothing field/window')
      known.add(s.as)
    }
  }
  if (v.metrics !== undefined) {
    if (!Array.isArray(v.metrics) || v.metrics.length > 6) throw new Error('At most six metrics')
    for (const m of v.metrics) {
      object(m, 'metric'); keys(m, ['label', 'field', 'aggregate', 'window', 'percent'], 'metric'); text(m.label, 'metric label', 80)
      if (!known.has(m.field) || !['last', 'mean'].includes(m.aggregate) || m.percent !== undefined && typeof m.percent !== 'boolean'
        || m.window !== undefined && (!Number.isInteger(m.window) || m.window < 1 || m.window > 20000)) throw new Error('Invalid metric')
    }
  }
  spec(v.spec, known)
  return JSON.parse(JSON.stringify(v))
}

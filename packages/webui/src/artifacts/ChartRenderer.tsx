import { useEffect, useMemo, useRef, useState } from 'react'
import { compile } from 'vega-lite'
import { View, parse } from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { validateChartDocument } from '../../../shared/src/artifacts/chart'
import type { StoredArtifact } from '../../../shared/src/artifacts/types'
export default function ChartRenderer({ artifact }: { artifact: StoredArtifact }) {
  const doc = useMemo(() => validateChartDocument(artifact.document), [artifact.document])
  const [windowSize, setWindowSize] = useState(doc.controls?.smoothing?.window || 20)
  const [recent, setRecent] = useState(true), [hidden, setHidden] = useState<string[]>([])
  const [error, setError] = useState(''), [tip, setTip] = useState('')
  const el = useRef<HTMLDivElement>(null), [width, setWidth] = useState(640), [theme, setTheme] = useState(0)
  const rows = useMemo(() => {
    const s = doc.controls?.smoothing
    if (!s) return doc.data
    let sum = 0, n = 0
    return doc.data.map((row, i) => {
      const value = row[s.field]; if (typeof value === 'number') { sum += value; n++ }
      if (i >= windowSize) { const old = doc.data[i - windowSize][s.field]; if (typeof old === 'number') { sum -= old; n-- } }
      return { ...row, [s.as]: n ? sum / n : null }
    })
  }, [doc, windowSize])
  useEffect(() => {
    if (!el.current) return
    const resize = new ResizeObserver(entries => setWidth(Math.max(180, Math.floor(entries[0].contentRect.width))))
    resize.observe(el.current)
    const observer = new MutationObserver(() => setTheme(n => n + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => { resize.disconnect(); observer.disconnect() }
  }, [])
  useEffect(() => {
    if (!el.current) return
    let view: View | undefined, disposed = false
    const container = document.createElement('div'); el.current.replaceChildren(container)
    setError(''); setTip('')
    try {
      const style = getComputedStyle(el.current)
      const color = style.color, accent = style.getPropertyValue('--foxwarm-color-accent').trim() || '#8873e6'
      const spec: any = { ...doc.spec, width: Math.max(120, width - 60), height: doc.spec.height || 300,
        data: { values: recent && doc.controls?.recent ? rows.slice(-doc.controls.recent) : rows },
        background: 'transparent', config: { font: 'system-ui', axis: { labelColor: color, titleColor: color, gridOpacity: .14, domainOpacity: .2, tickOpacity: .2 }, legend: { labelColor: color, titleColor: color }, title: { color }, view: { stroke: null }, mark: { color: accent }, range: { category: [accent, '#20bfa9', '#e1a84d', '#d975ab'] } } }
      if (spec.layer) spec.layer = spec.layer.filter((l: any) => !hidden.includes(l.name)).map((l: any) => { const { title: _title, ...layer } = l; return layer })
      if (spec.layer && !spec.layer.length) { el.current.replaceChildren(); return }
      // Compile only our closed subset; evaluate generated expressions without eval/new Function.
      const runtime = parse(compile(spec).spec, undefined, { ast: true })
      view = new View(runtime, { renderer: 'svg', container, hover: true, expr: expressionInterpreter,
        loader: { load: async () => { throw new Error('External chart resources are disabled') }, sanitize: async () => { throw new Error('External chart links are disabled') } } as any })
      view.tooltip((_handler, _event, _item, value) => { if (!disposed) setTip(value && typeof value === 'object' ? Object.entries(value).slice(0, 8).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(' · ') : '') })
      void view.runAsync().catch(() => { if (!disposed) setError('Chart could not be rendered') })
    } catch { setError('Chart could not be rendered') }
    return () => { disposed = true; view?.finalize(); container.remove() }
  }, [doc, rows, recent, hidden, width, theme])
  const metric = (m: NonNullable<typeof doc.metrics>[number]) => {
    const selected = m.window ? rows.slice(-m.window) : rows
    const data = selected.map(r => r[m.field]).filter((x): x is number => typeof x === 'number')
    const last = selected.at(-1)?.[m.field]
    const value = m.aggregate === 'last' ? (typeof last === 'number' ? last : undefined) : data.length ? data.reduce((a, b) => a + b, 0) / data.length : undefined
    return value === undefined ? '—' : m.percent ? `${(value * 100).toFixed(2)}%` : new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)
  }
  return <div className="artifact-chart">
    {!!doc.metrics?.length && <div className="artifact-metrics">{doc.metrics.map((m, i) => <div key={i}><strong>{metric(m)}</strong><span>{m.label}</span></div>)}</div>}
    <div ref={el} className="artifact-chart-plot" role="img" aria-label={doc.title} />
    {error && <p role="alert">{error}</p>}
    <div className="artifact-chart-tooltip" aria-live="off">{tip}</div>
    <div className="artifact-chart-controls">
      {doc.controls?.recent && <label><input type="checkbox" checked={recent} onChange={e => setRecent(e.target.checked)} /> Latest {doc.controls.recent}</label>}
      {doc.spec.layer?.filter((l: any) => l.name).map((l: any) => <label key={l.name}><input type="checkbox" checked={!hidden.includes(l.name)} onChange={e => setHidden(a => e.target.checked ? a.filter(x => x !== l.name) : [...a, l.name])} /><span className="artifact-series-swatch" aria-hidden="true" style={{ background: l.mark?.color || 'var(--foxwarm-color-accent)' }} />{l.title || l.name}</label>)}
      {doc.controls?.smoothing && <label className="artifact-range">Smoothing <output>{windowSize}</output><input aria-label="Smoothing window" type="range" min="1" max="200" value={windowSize} onChange={e => setWindowSize(Number(e.target.value))} /></label>}
    </div>

  </div>
}

import { Component, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Maximize2, Minimize2, Code2, ChartNoAxesCombined, X } from 'lucide-react'
import { makeApiUrl } from '../config'
import { parseArtifactReceipt, type ArtifactReceipt, type StoredArtifact } from '../../../shared/src/artifacts/types'
import type { ArtifactReference } from '../../../shared/src/artifacts/marker'
import { artifactRenderers, artifactDownloads } from './registry'
class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="alert">This artifact could not be rendered. Its source is still available.</p> : this.props.children }
}
type Props = { receipt: ArtifactReceipt; reference?: never; sessionId?: never } | { receipt?: never; reference: ArtifactReference; sessionId: string }
export default function ArtifactView({ receipt, reference, sessionId }: Props) {
  const ownerId = receipt?.sessionId || sessionId!, artifactId = receipt?.artifactId || reference!.artifactId, revision = receipt?.revision || reference!.revision

  const [artifact, setArtifact] = useState<StoredArtifact>(), [error, setError] = useState(''), [downloadError, setDownloadError] = useState(''), [downloading, setDownloading] = useState(false), [expanded, setExpanded] = useState(false), [visible, setVisible] = useState(false)
  const root = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '300px' })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(); let alive = true
    void (async () => {
      try {
        const response = await fetch(makeApiUrl(`/sessions/${encodeURIComponent(ownerId)}/artifacts/${artifactId}/${revision}`), { signal: controller.signal })
        if (!response.ok) throw new Error(response.status === 404 ? 'Artifact unavailable' : 'Could not load artifact')
        const record = await response.json() as StoredArtifact, parsed = parseArtifactReceipt(record.receipt)
        if (!parsed || parsed.sessionId !== ownerId || parsed.artifactId !== artifactId || parsed.revision !== revision || receipt && parsed.type !== receipt.type) throw new Error('Invalid artifact response')
        if (alive) setArtifact(record)
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : 'Could not load artifact') }
    })()
    return () => { alive = false; controller.abort() }
  }, [visible, artifactId, revision, ownerId, receipt?.type])
  useLayoutEffect(() => {
    const dialog = root.current
    if (!dialog) return
    if (dialog.matches(':modal')) dialog.close()
    else dialog.removeAttribute('open')
    // Opening an inline, non-modal dialog must not steal the composer focus.
    if (expanded) dialog.showModal(); else dialog.setAttribute('open', '')
    if (expanded) opener.current?.focus({ preventScroll: true })
  }, [expanded])
  useEffect(() => {
    if (!expanded) return
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = old; opener.current?.focus({ preventScroll: true }) }
  }, [expanded])
  const type = artifact?.receipt.type || receipt?.type
  const Renderer = type ? artifactRenderers[type as keyof typeof artifactRenderers] : undefined
  const title = artifact?.receipt.title || receipt?.title || 'Preview'
  const bare = !type || type === 'image'
  const Icon = type === 'chart' ? ChartNoAxesCombined : Code2
  const download = async () => {
    if (!artifact || downloading) return
    setDownloading(true); setDownloadError('')
    try { await (artifactDownloads[artifact.receipt.type as keyof typeof artifactDownloads] || artifactDownloads.chart)(artifact) }
    catch { setDownloadError('Download unavailable') } finally { setDownloading(false) }
  }
  return <div className="artifact-slot"><dialog ref={root} onCancel={e => { e.preventDefault(); setExpanded(false) }} className={`artifact-view${bare ? ' artifact-bare' : ''}${expanded ? ' artifact-expanded' : ''}`} data-artifact-id={artifactId} data-artifact-revision={revision} role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined} aria-label={title}>
    {!bare && <header><Icon size={17} /><h3>{title}</h3><button disabled={!artifact || downloading} onClick={() => { void download() }} aria-label="Download artifact"><Download size={16} /></button><button ref={opener} onClick={() => setExpanded(v => !v)} aria-label={expanded ? 'Collapse artifact' : 'Expand artifact'}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>{expanded && <button aria-label="Close artifact" onClick={() => setExpanded(false)}><X size={16} /></button>}</header>}
    {!bare && artifact?.document.description && <p className="artifact-description">{artifact.document.description}</p>}
    {downloadError && <p role="alert">{downloadError}</p>}
    {error ? <p role="alert">{error}</p> : !artifact ? <div className="artifact-loading">Loading preview…</div> : <RenderBoundary><Suspense fallback={<div className="artifact-loading">Loading preview…</div>}>{Renderer ? <Renderer artifact={artifact} /> : <p>Preview not supported. Download the source to open it elsewhere.</p>}</Suspense></RenderBoundary>}
  </dialog></div>
}

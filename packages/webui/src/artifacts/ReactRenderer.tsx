import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Play, RotateCcw, Square } from 'lucide-react'
import type { StoredArtifact } from '../../../shared/src/artifacts/types'
import { sandboxDocument } from './sandbox'
export default function ReactRenderer({ artifact }: { artifact: StoredArtifact }) {
  const [running, setRunning] = useState(false), [generation, setGeneration] = useState(0), [error, setError] = useState(''), [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useMemo(() => crypto.randomUUID(), [generation])
  const srcDoc = useMemo(() => running ? sandboxDocument(artifact.compiled || '', channel) : '', [artifact.compiled, channel, running])
  useLayoutEffect(() => {
    if (!running) return
    const theme = () => { const s = getComputedStyle(document.documentElement); frame.current?.contentWindow?.postMessage({ channel, type: 'theme', theme: { bg: s.getPropertyValue('--foxwarm-color-surface').trim() || '#ffffff', text: s.getPropertyValue('--foxwarm-color-text').trim() || '#20242b', accent: s.getPropertyValue('--foxwarm-color-accent').trim() || '#8764db', 'accent-text': s.getPropertyValue('--foxwarm-color-accent-text').trim() || '#ffffff' } }, '*') }
    const listener = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.channel !== channel) return
      if (e.data.type === 'ready') { setReady(true); theme() }
      if (e.data.type === 'error' && typeof e.data.message === 'string') { setError(e.data.message.slice(0, 300)); setRunning(false) }
    }
    const visibility = () => { if (document.hidden) setRunning(false) }
    const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    window.addEventListener('message', listener); document.addEventListener('visibilitychange', visibility)
    const timer = setTimeout(() => { if (!frame.current?.dataset.ready) { setError('Preview did not start. Try Reset.'); setRunning(false) } }, 20000)
    return () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener('message', listener); document.removeEventListener('visibilitychange', visibility) }
  }, [running, channel])
  const start = () => { setError(''); setReady(false); setGeneration(n => n + 1); setRunning(true) }
  return <div className="artifact-react">
    <div className="artifact-run-controls"><button onClick={running ? () => setRunning(false) : start}>{running ? <Square size={14} /> : <Play size={14} />}{running ? 'Stop' : 'Run'}</button><button onClick={start}><RotateCcw size={14} />Reset</button>{running && !ready && <span>Starting…</span>}</div>
    {error && <p role="alert">{error}</p>}
    {running ? <iframe ref={frame} sandbox="allow-scripts" referrerPolicy="no-referrer" title={artifact.receipt.title} srcDoc={srcDoc} data-ready={ready || undefined} className="artifact-sandbox" /> : <button className="artifact-run-placeholder" onClick={start}><Play size={28} /><span>Run interactive preview</span></button>}
  </div>
}

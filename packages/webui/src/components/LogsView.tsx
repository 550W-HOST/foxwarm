import { WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, FileText } from 'lucide-react'
import { makeApiUrl } from '../config'
import { webUiRealtime } from '../realtime'

type LogWindow = {
  fileId: string | null; size: number; startOffset: number; endOffset: number
  text: string; lineCount: number; startsMidLine: boolean; endsMidLine: boolean
  pendingBytes: number; missing: boolean
}

const DISPLAY_BYTES = 200 * 1024
const MAX_DISPLAY_BLOCKS = 128

function cleanText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function appendWindow(current: LogWindow[], next: LogWindow): LogWindow[] {
  const last = current[current.length - 1]
  if (!last || last.fileId !== next.fileId || last.endOffset !== next.startOffset) throw new Error('The live log position changed. Return to latest logs.')
  if (!next.text) return [...current.slice(0, -1), { ...last, size: next.size, pendingBytes: next.pendingBytes }]
  const blocks = [...current]
  // Merge small chunks without deriving any cursor from decoded or cleaned text.
  if (next.endOffset - last.startOffset <= 32 * 1024) {
    blocks[blocks.length - 1] = { ...next, startOffset: last.startOffset, startsMidLine: last.startsMidLine, text: last.text + next.text }
  } else blocks.push(next)
  while (blocks.length > 1 && (blocks.length > MAX_DISPLAY_BLOCKS || next.endOffset - blocks[0].startOffset > DISPLAY_BYTES)) blocks.shift()
  return blocks
}

export default function LogsView({ onBack }: { onBack?: () => void }) {
  const tabHeader = useWorkbenchTabHeader()
  const [blocks, setBlocks] = useState<LogWindow[]>([])
  const [live, setLive] = useState(true)
  const [liveEpoch, setLiveEpoch] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [time, setTime] = useState(() => {
    const today = new Date()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    return `${today.getFullYear()}-${month}-${day}T00:00`
  })
  const [locatedTime, setLocatedTime] = useState('')
  const viewport = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const rawText = blocks.map(block => block.text).join('')
  const text = cleanText(rawText)
  const lines = rawText ? rawText.split('\n').length - (rawText.endsWith('\n') ? 1 : 0) : 0

  useEffect(() => {
    if (!live) return
    let active = true
    setBusy(true)
    setError('')
    setLocatedTime('')
    const unsubscribe = webUiRealtime.subscribeLogs({
      onMessage: message => {
        if (!active) return
        if (message.type === 'logs-snapshot') {
          const window = message.window as LogWindow
          blocksRef.current = [window]
          setBlocks([window])
          setBusy(false)
          follow.current = true
        } else if (message.type === 'logs-delta') {
          try {
            const next = appendWindow(blocksRef.current, message.window as LogWindow)
            blocksRef.current = next
            setBlocks(next)
            setBusy(false)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Unable to follow logs.')
            setLive(false)
            setBusy(false)
          }
        } else if (['logs-gap', 'logs-reset', 'logs-error'].includes(message.type)) {
          setError(message.message || 'Unable to follow logs. Return to latest logs.')
          setLive(false)
          setBusy(false)
        }
      },
    })
    return () => { active = false; unsubscribe() }
  }, [live, liveEpoch])

  useEffect(() => () => { generation.current++; request.current?.abort() }, [])

  useLayoutEffect(() => {
    if (live && follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [last?.endOffset, live, liveEpoch])

  const load = async (direction: 'before' | 'after' | 'time') => {
    if (!first?.fileId || !last) return
    setLive(false)
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const epoch = ++generation.current
    setBusy(true)
    setError('')
    const url = makeApiUrl('/webui/logs')
    url.searchParams.set('fileId', first.fileId)
    if (direction === 'time') {
      const parsed = new Date(time)
      if (!time || !Number.isFinite(parsed.getTime())) { setError('Choose a valid date and time.'); setBusy(false); return }
      url.searchParams.set('time', parsed.toISOString())
    } else {
      url.searchParams.set('direction', direction)
      url.searchParams.set('offset', String(direction === 'before' ? first.startOffset : last.endOffset))
    }
    try {
      const response = await fetch(url, { signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to read logs.')
      if (epoch !== generation.current) return
      blocksRef.current = [data.window]
      setBlocks([data.window])
      setLocatedTime(data.locatedTime || '')
      if (viewport.current) viewport.current.scrollTop = 0
    } catch (cause) {
      if (epoch === generation.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to read logs.')
    } finally { if (epoch === generation.current) setBusy(false) }
  }

  const latest = () => {
    generation.current++
    request.current?.abort()
    follow.current = true
    setLive(true)
    setLiveEpoch(value => value + 1)
  }
  const buttonClass = 'rounded border border-fw-border px-2 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:opacity-40'

  return <section data-logs-view aria-busy={busy} className="flex h-full min-h-0 flex-col bg-fw-canvas text-fw-text">
    <div data-logs-toolbar className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-fw-border bg-fw-surface p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {tabHeader ? <WorkbenchTabClose className={buttonClass} iconClassName="h-4 w-4" /> : onBack && <button type="button" className={buttonClass} onClick={onBack} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>}
        <h2 className="mr-2 flex items-center gap-2 text-sm font-semibold"><WorkbenchTabIcon className="inline-flex items-center"><FileText className="h-4 w-4" /></WorkbenchTabIcon>Logs</h2>
        <button type="button" className={buttonClass} disabled={busy || !first || first.startOffset === 0} onClick={() => void load('before')}>Older</button>
        <button type="button" className={buttonClass} disabled={busy || live || !last || last.endOffset >= last.size - last.pendingBytes} onClick={() => void load('after')}>Newer</button>
        <button type="button" className={buttonClass} onClick={latest}>Latest · Live</button>
        <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void load('time') }}>
          <input type="datetime-local" step="1" aria-label="Log date and time" value={time} onChange={event => setTime(event.target.value)} className="min-w-0 rounded border border-fw-border bg-fw-surface px-2 py-1 text-xs text-fw-text" />
          <button type="submit" className={buttonClass} disabled={busy || !first?.fileId || !time} title="Approximate lookup. Older time-only logs cannot be located by date.">Jump</button>
        </form>
      </div>
      <div className="flex items-center gap-2">
        <span data-logs-line-count className="whitespace-nowrap text-right text-xs text-fw-text-muted">{lines} {lines === 1 ? 'line' : 'lines'} shown</span>
        <WorkbenchPaneControls />
      </div>
    </div>
    {error && <div role="alert" className="shrink-0 border-b border-fw-border bg-fw-danger-surface px-3 py-2 text-sm text-fw-danger">{error}</div>}
    {locatedTime && <div className="shrink-0 px-3 py-2 text-xs text-fw-text-muted">Located near {new Date(locatedTime).toLocaleString()} (approximate)</div>}
    {first?.missing ? <div className="p-4 text-sm text-fw-text-muted">No log file yet.</div> : !busy && last?.size === 0 ? <div className="p-4 text-sm text-fw-text-muted">The log file is empty.</div> : null}
    <pre ref={viewport} data-logs-text data-start-offset={first?.startOffset} data-end-offset={last?.endOffset} onScroll={() => {
      const element = viewport.current
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 4
    }} className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre p-3 font-mono text-xs leading-5" tabIndex={0}>{text}</pre>
  </section>
}

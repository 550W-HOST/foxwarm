import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, X } from 'lucide-react'
import { copyTextToClipboard } from './chatShared'
import SimpleCodeEditor from './SimpleCodeEditor'

interface JsonInspectorDialogProps {
  text: string
  onClose: () => void
  title?: string
  loading?: boolean
  onRefresh?: () => void
  status?: ReactNode
  snapshotVersion?: number
}

const ignoreChange = () => {}

export default function JsonInspectorDialog({
  text,
  onClose,
  title = 'JSON',
  loading = false,
  onRefresh,
  status,
  snapshotVersion = 0,
}: JsonInspectorDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const copyTimeoutRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    const previousFocus = document.activeElement
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      mountedRef.current = false
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => { setCopied(false) }, [snapshotVersion])

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(text)
      if (!mountedRef.current) return
      setCopied(true)
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy JSON:', error)
    }
  }

  return createPortal(
    <div
      data-json-inspector-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-fw-overlay/50 p-2 sm:p-4"
      onClick={(event) => { event.stopPropagation(); onClose() }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onKeyDown={(event) => {
        // Portal events still bubble through the owning card/Chat. Keep editor Find local.
        event.stopPropagation()
        if (event.key !== 'Tab') return
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, [tabindex="0"]') || [])
          .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus({ preventScroll: true })
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus({ preventScroll: true })
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-json-inspector-dialog
        className="flex h-[85vh] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-2xl dark:bg-fw-canvas"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-fw-border px-3 py-3 sm:px-4">
          <div id={titleId} className="text-sm font-semibold text-fw-text-strong">{title}</div>
          <div className="flex items-center gap-2">
            {onRefresh && <button onClick={onRefresh} className="rounded border border-fw-border px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover">Refresh</button>}
            <button onClick={handleCopy} disabled={!text || loading} className="inline-flex items-center gap-1 rounded border border-fw-border px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-50">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button ref={closeRef} onClick={onClose} aria-label="Close" title="Close" className="rounded p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong"><X size={18} /></button>
          </div>
        </div>
        {status}
        {loading && <div role="status" className="shrink-0 px-4 py-2 text-xs text-fw-text-muted">Loading…</div>}
        <div data-json-inspector-content className="min-h-0 flex-1">
          {text && <SimpleCodeEditor key={snapshotVersion} value={text} onChange={ignoreChange} language="json" readOnly height="100%" initialFoldLevel={2} focusRequest={1} ariaLabel={title} />}
        </div>
      </div>
    </div>, document.body,
  )
}

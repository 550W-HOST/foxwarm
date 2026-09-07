import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, FileText, X } from 'lucide-react'
import { copyTextToClipboard } from './chatShared'
import { countPastedTextCharacters, getPastedTextPreview } from '../pastedText'

function PastedTextModal({ text, onClose }: { text: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const count = useMemo(() => countPastedTextCharacters(text), [text])

  useEffect(() => {
    closeButtonRef.current?.focus()
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') || [])]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [onClose])

  const handleCopy = useCallback(async () => {
    await copyTextToClipboard(text)
    setCopied(true)
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
  }, [text])

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-fw-overlay/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="foxwarm-pasted-text-title"
        onKeyDown={handleKeyDown}
        className="flex max-h-[min(80vh,48rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-2xl dark:border-fw-border dark:bg-fw-canvas"
      >
        <div className="flex items-center gap-3 border-b border-fw-border px-4 py-3 dark:border-fw-border">
          <FileText size={17} className="shrink-0 text-fw-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="foxwarm-pasted-text-title" className="font-semibold text-fw-text-strong">Pasted text</h2>
            <div className="text-xs text-fw-text-muted">{count.toLocaleString()} {count === 1 ? 'character' : 'characters'} · Read only</div>
          </div>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-fw-text hover:bg-fw-hover hover:text-fw-text-strong"
            aria-label="Copy pasted text"
          >
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong"
            aria-label="Close pasted text"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <textarea
          readOnly
          value={text}
          aria-label="Full pasted text"
          className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre-wrap border-0 bg-fw-surface-sunken p-4 font-mono text-sm leading-6 text-fw-text-strong outline-none dark:bg-fw-canvas-edge"
        />
      </div>
    </div>,
    document.body,
  )
}

const PastedTextBlock = memo(function PastedTextBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const preview = useMemo(() => getPastedTextPreview(text), [text])
  const count = useMemo(() => countPastedTextCharacters(text), [text])

  const close = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="foxwarm-pasted-text-block mx-0.5 inline-flex max-w-[min(24rem,100%)] items-center gap-1.5 rounded-md border border-fw-accent-border/60 bg-fw-accent-surface px-2 py-0.5 align-middle text-left text-xs leading-5 text-fw-accent shadow-sm hover:bg-fw-accent-surface-strong focus:outline-none focus:ring-2 focus:ring-fw-focus-ring dark:bg-fw-accent-surface-strong/25 dark:hover:bg-fw-accent-surface-strong/40"
        aria-label={`Open pasted text, ${count} ${count === 1 ? 'character' : 'characters'}`}
      >
        <FileText size={13} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{preview}</span>
        <span className="shrink-0 text-fw-text-muted">{count.toLocaleString()}</span>
      </button>
      {open && <PastedTextModal text={text} onClose={close} />}
    </>
  )
})

export default PastedTextBlock

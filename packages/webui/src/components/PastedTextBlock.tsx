import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, FileText, RotateCcw, X } from 'lucide-react'
import { copyTextToClipboard } from './chatShared'
import { countPastedTextCharacters, getPastedTextPreview, PASTED_TEXT_CLOSE } from '../pastedText'

export interface PastedTextModalProps {
  text: string
  onClose: () => void
  onSave?: (text: string) => void
  onRestoreToText?: (text: string) => void
}

export function PastedTextModal({ text, onClose, onSave, onRestoreToText }: PastedTextModalProps) {
  const editable = !!onSave
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [draftText, setDraftText] = useState(text)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const count = useMemo(() => countPastedTextCharacters(draftText), [draftText])
  const delimiterCollision = editable && draftText.includes(PASTED_TEXT_CLOSE)

  useEffect(() => {
    if (editable) textareaRef.current?.focus()
    else closeButtonRef.current?.focus()
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }
  }, [editable])

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
    await copyTextToClipboard(draftText)
    setCopied(true)
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
  }, [draftText])

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
        style={{ width: 'min(80vw, calc(100vw - 2rem))', height: 'min(80dvh, calc(100dvh - 2rem))' }}
        className="flex h-[80dvh] max-h-[calc(100dvh-2rem)] w-[80vw] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-2xl dark:border-fw-border dark:bg-fw-canvas"
      >
        <div className="flex items-center gap-3 border-b border-fw-border px-4 py-3 dark:border-fw-border">
          <FileText size={17} className="shrink-0 text-fw-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="foxwarm-pasted-text-title" className="font-semibold text-fw-text-strong">Pasted text</h2>
            <div className="text-xs text-fw-text-muted">{count.toLocaleString()} {count === 1 ? 'character' : 'characters'} · {editable ? 'Editable draft' : 'Read only'}</div>
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
          ref={textareaRef}
          readOnly={!editable}
          value={draftText}
          onChange={editable ? event => setDraftText(event.target.value) : undefined}
          aria-label="Full pasted text"
          className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre-wrap border-0 bg-fw-surface-sunken p-4 font-mono text-sm leading-6 text-fw-text-strong outline-none focus:ring-2 focus:ring-inset focus:ring-fw-focus-ring dark:bg-fw-canvas-edge"
        />
        {editable && (
          <div className="border-t border-fw-border px-4 py-3 dark:border-fw-border">
            {delimiterCollision && (
              <div className="mb-2 text-sm text-fw-danger" role="alert">Pasted text cannot contain the closing &lt;/pasted-text&gt; delimiter. Restore it to ordinary text or remove the delimiter.</div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {onRestoreToText && (
                <button type="button" onClick={() => onRestoreToText(draftText)} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-fw-text hover:bg-fw-hover">
                  <RotateCcw size={15} aria-hidden="true" />
                  Restore to text
                </button>
              )}
              <button type="button" onClick={onClose} className="h-9 rounded-lg px-3 text-sm text-fw-text hover:bg-fw-hover">Cancel</button>
              <button
                type="button"
                disabled={delimiterCollision}
                onClick={() => onSave?.(draftText)}
                className="h-9 rounded-lg bg-fw-accent px-3 text-sm font-medium text-fw-text-inverse disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}
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

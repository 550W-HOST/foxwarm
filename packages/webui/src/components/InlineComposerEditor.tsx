import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  canConvertPasteToBlock,
  makeComposerDraft,
  serializeComposerDraft,
  type ComposerDraft,
  type ComposerDraftSegment,
  type ComposerPastedTextSegment,
} from '../composerDraft'
import { countPastedTextCharacters, getPastedTextPreview } from '../pastedText'
import { PastedTextModal } from './PastedTextBlock'

const MAX_UNDO_ENTRIES = 80
const MAX_UNDO_BYTES = 2_000_000
const TYPING_COALESCE_MS = 750

export interface InlineComposerEditorHandle {
  focus: () => void
  focusEnd: () => void
  replaceDraft: (draft: ComposerDraft, focusEnd?: boolean) => void
}

interface InlineComposerEditorProps {
  draftId: string
  value: ComposerDraft
  disabled: boolean
  placeholder: string
  onChange: (draft: ComposerDraft) => void
  onBlur: () => void
  onPasteImages: (files: File[]) => void
  onCommandKeyDown: (event: KeyboardEvent) => boolean
}

type HistoryGroup = { kind: string; at: number } | null

type DraftSnapshot = { draft: ComposerDraft; size: number }

function getDraftByteSize(draft: ComposerDraft): number {
  return new TextEncoder().encode(serializeComposerDraft(draft)).byteLength
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return makeComposerDraft(draft.segments.map(segment => ({ ...segment })))
}

function sameDraft(left: ComposerDraft, right: ComposerDraft): boolean {
  return serializeComposerDraft(left) === serializeComposerDraft(right)
}

function isChip(node: Node | null): boolean {
  return node instanceof HTMLElement && node.dataset.composerPastedTextId !== undefined
}

const InlineComposerEditor = forwardRef<InlineComposerEditorHandle, InlineComposerEditorProps>(function InlineComposerEditor({
  draftId,
  value,
  disabled,
  placeholder,
  onChange,
  onBlur,
  onPasteImages,
  onCommandKeyDown,
}, forwardedRef) {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const blockMapRef = useRef(new Map<string, ComposerPastedTextSegment>())
  const undoRef = useRef<DraftSnapshot[]>([])
  const redoRef = useRef<DraftSnapshot[]>([])
  const historyGroupRef = useRef<HistoryGroup>(null)
  const beforeInputRef = useRef<ComposerDraft | null>(null)
  const compositionBaseRef = useRef<ComposerDraft | null>(null)
  const composingRef = useRef(false)
  const lastEmittedRef = useRef('')
  const lastDraftIdRef = useRef('')
  const activeChipRef = useRef<HTMLElement | null>(null)
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)

  const readNodeSegments = useCallback((node: Node, output: ComposerDraftSegment[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      output.push({ type: 'text', text: node.nodeValue || '' })
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (isChip(node)) {
      const segment = blockMapRef.current.get(node.dataset.composerPastedTextId || '')
      if (segment) output.push({ ...segment })
      return
    }
    if (node.tagName === 'BR') {
      output.push({ type: 'text', text: '\n' })
      return
    }
    const outputStart = output.length
    for (const child of node.childNodes) readNodeSegments(child, output)
    if ((node.tagName === 'DIV' || node.tagName === 'P') && outputStart > 0) {
      output.splice(outputStart, 0, { type: 'text', text: '\n' })
    }
  }, [])

  const readDraftFromNode = useCallback((root: ParentNode): ComposerDraft => {
    const segments: ComposerDraftSegment[] = []
    for (const child of root.childNodes) readNodeSegments(child, segments)
    return makeComposerDraft(segments)
  }, [readNodeSegments])

  const readDraft = useCallback((): ComposerDraft => {
    return editorRef.current ? readDraftFromNode(editorRef.current) : makeComposerDraft([])
  }, [readDraftFromNode])

  const updateEmptyState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.dataset.empty = serializeComposerDraft(readDraft()).length === 0 ? 'true' : 'false'
  }, [readDraft])

  const emitDraft = useCallback(() => {
    const next = readDraft()
    lastEmittedRef.current = serializeComposerDraft(next)
    updateEmptyState()
    onChange(next)
  }, [onChange, readDraft, updateEmptyState])

  const createChip = useCallback((segment: ComposerPastedTextSegment): HTMLElement => {
    blockMapRef.current.set(segment.id, { ...segment })
    const chip = document.createElement('span')
    chip.className = 'foxwarm-composer-pasted-text-chip foxwarm-pasted-text-block mx-0.5 inline-flex max-w-[min(24rem,100%)] items-center gap-1.5 rounded-md border border-fw-accent-border/60 bg-fw-accent-surface px-2 py-0.5 align-middle text-left text-xs leading-5 text-fw-accent shadow-sm hover:bg-fw-accent-surface-strong focus:outline-none focus:ring-2 focus:ring-fw-focus-ring dark:bg-fw-accent-surface-strong/25 dark:hover:bg-fw-accent-surface-strong/40'
    chip.contentEditable = 'false'
    chip.tabIndex = 0
    chip.setAttribute('role', 'button')
    chip.dataset.composerPastedTextId = segment.id
    const icon = document.createElement('span')
    icon.className = 'shrink-0'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '▤'
    const preview = document.createElement('span')
    preview.className = 'foxwarm-composer-pasted-text-preview min-w-0 truncate'
    preview.textContent = getPastedTextPreview(segment.text)
    const count = document.createElement('span')
    count.className = 'foxwarm-composer-pasted-text-count shrink-0 text-fw-text-muted'
    count.textContent = countPastedTextCharacters(segment.text).toLocaleString()
    chip.append(icon, preview, count)
    chip.setAttribute('aria-label', `Edit pasted text, ${countPastedTextCharacters(segment.text)} characters`)
    return chip
  }, [])

  const renderDraft = useCallback((draft: ComposerDraft) => {
    const editor = editorRef.current
    if (!editor) return
    blockMapRef.current.clear()
    const fragment = document.createDocumentFragment()
    for (const segment of draft.segments) {
      fragment.append(segment.type === 'text' ? document.createTextNode(segment.text) : createChip(segment))
    }
    editor.replaceChildren(fragment)
    updateEmptyState()
  }, [createChip, updateEmptyState])

  const placeCaret = useCallback((container: Node, offset: number) => {
    const editor = editorRef.current
    if (!editor) return
    const range = document.createRange()
    range.setStart(container, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    editor.focus()
  }, [])

  const focusEnd = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    placeCaret(editor, editor.childNodes.length)
  }, [placeCaret])

  const trimHistory = useCallback(() => {
    let total = [...undoRef.current, ...redoRef.current].reduce((sum, item) => sum + item.size, 0)
    while (undoRef.current.length + redoRef.current.length > MAX_UNDO_ENTRIES || total > MAX_UNDO_BYTES) {
      const removed = undoRef.current.length > 0 ? undoRef.current.shift() : redoRef.current.shift()
      total -= removed?.size || 0
    }
  }, [])

  const recordHistory = useCallback((base: ComposerDraft, kind: string, coalesce = false) => {
    const current = readDraft()
    if (sameDraft(base, current)) return
    const now = Date.now()
    const previousGroup = historyGroupRef.current
    if (!(coalesce && previousGroup?.kind === kind && now - previousGroup.at <= TYPING_COALESCE_MS)) {
      undoRef.current.push({ draft: cloneDraft(base), size: getDraftByteSize(base) })
      trimHistory()
    }
    historyGroupRef.current = { kind, at: now }
    redoRef.current = []
  }, [readDraft, trimHistory])

  const applyHistoryDraft = useCallback((draft: ComposerDraft) => {
    renderDraft(draft)
    lastEmittedRef.current = serializeComposerDraft(draft)
    onChange(cloneDraft(draft))
    focusEnd()
  }, [focusEnd, onChange, renderDraft])

  const undo = useCallback(() => {
    const previous = undoRef.current.pop()
    if (!previous) return
    const current = readDraft()
    redoRef.current.push({ draft: cloneDraft(current), size: getDraftByteSize(current) })
    trimHistory()
    historyGroupRef.current = null
    applyHistoryDraft(previous.draft)
  }, [applyHistoryDraft, readDraft, trimHistory])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    const current = readDraft()
    undoRef.current.push({ draft: cloneDraft(current), size: getDraftByteSize(current) })
    trimHistory()
    historyGroupRef.current = null
    applyHistoryDraft(next.draft)
  }, [applyHistoryDraft, readDraft, trimHistory])

  const replaceDraft = useCallback((nextDraft: ComposerDraft, shouldFocusEnd = false) => {
    renderDraft(nextDraft)
    undoRef.current = []
    redoRef.current = []
    historyGroupRef.current = null
    lastEmittedRef.current = serializeComposerDraft(nextDraft)
    if (shouldFocusEnd) focusEnd()
  }, [focusEnd, renderDraft])

  useImperativeHandle(forwardedRef, () => ({
    focus: () => editorRef.current?.focus(),
    focusEnd,
    replaceDraft,
  }), [focusEnd, replaceDraft])

  const insertTextAtSelection = useCallback((text: string) => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const textNode = document.createTextNode(text)
    range.insertNode(textNode)
    placeCaret(textNode, textNode.data.length)
    editor.normalize()
  }, [placeCaret])

  const mutate = useCallback((kind: string, action: () => void) => {
    const base = readDraft()
    action()
    recordHistory(base, kind)
    emitDraft()
  }, [emitDraft, readDraft, recordHistory])

  const insertPastedText = useCallback((text: string) => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return
    mutate('paste-block', () => {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const segment: ComposerPastedTextSegment = { type: 'pasted-text', id: globalThis.crypto?.randomUUID?.() || `paste-${Date.now()}-${Math.random().toString(16).slice(2)}`, text }
      const chip = createChip(segment)
      range.insertNode(chip)
      placeCaret(chip.parentNode || editor, [...(chip.parentNode || editor).childNodes].indexOf(chip) + 1)
    })
  }, [createChip, mutate, placeCaret])

  const adjacentChip = useCallback((direction: -1 | 1): HTMLElement | null => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.isCollapsed || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset
    if (container === editor) {
      const candidate = editor.childNodes[offset + (direction < 0 ? -1 : 0)]
      return isChip(candidate) ? candidate as HTMLElement : null
    }
    if (container.nodeType === Node.TEXT_NODE && ((direction < 0 && offset === 0) || (direction > 0 && offset === (container.nodeValue || '').length))) {
      const candidate = direction < 0 ? container.previousSibling : container.nextSibling
      return isChip(candidate) ? candidate as HTMLElement : null
    }
    return null
  }, [])

  const removeChip = useCallback((chip: HTMLElement) => {
    mutate('remove-block', () => {
      const parent = chip.parentNode
      if (!parent) return
      const index = [...parent.childNodes].indexOf(chip)
      blockMapRef.current.delete(chip.dataset.composerPastedTextId || '')
      chip.remove()
      placeCaret(parent, Math.max(0, index))
    })
  }, [mutate, placeCaret])

  const serializeSelection = useCallback((range: Range): string => {
    const fragment = range.cloneContents()
    return serializeComposerDraft(readDraftFromNode(fragment))
  }, [readDraftFromNode])

  useEffect(() => {
    const serialized = serializeComposerDraft(value)
    const draftChanged = lastDraftIdRef.current !== draftId
    if (draftChanged || serialized !== lastEmittedRef.current) {
      renderDraft(value)
      undoRef.current = []
      redoRef.current = []
      historyGroupRef.current = null
      lastEmittedRef.current = serialized
      lastDraftIdRef.current = draftId
      setActiveBlockId(null)
    }
  }, [draftId, renderDraft, value])

  const activeBlock = activeBlockId ? blockMapRef.current.get(activeBlockId) || null : null
  const closeModal = useCallback(() => {
    setActiveBlockId(null)
    requestAnimationFrame(() => activeChipRef.current?.focus())
  }, [])

  return (
    <div className="relative mb-1.5">
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Message"
        aria-multiline="true"
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        className="foxwarm-chat-composer-textarea foxwarm-inline-composer-editor min-h-[60px] max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-1 text-[16px] leading-6 text-fw-text-strong outline-none focus:ring-0 dark:text-fw-text-strong"
        onBeforeInput={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent
          if (nativeEvent.inputType === 'historyUndo') { event.preventDefault(); undo(); return }
          if (nativeEvent.inputType === 'historyRedo') { event.preventDefault(); redo(); return }
          if (nativeEvent.inputType === 'insertParagraph' || nativeEvent.inputType === 'insertLineBreak') {
            event.preventDefault()
            mutate('line-break', () => insertTextAtSelection('\n'))
            return
          }
          beforeInputRef.current = readDraft()
        }}
        onInput={(event) => {
          const nativeEvent = event.nativeEvent as InputEvent
          if (!composingRef.current && beforeInputRef.current) {
            const coalesce = nativeEvent.inputType === 'insertText' || nativeEvent.inputType.startsWith('deleteContent')
            recordHistory(beforeInputRef.current, nativeEvent.inputType || 'input', coalesce)
          }
          beforeInputRef.current = null
          emitDraft()
        }}
        onCompositionStart={() => {
          composingRef.current = true
          compositionBaseRef.current = readDraft()
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          if (compositionBaseRef.current) recordHistory(compositionBaseRef.current, 'composition')
          compositionBaseRef.current = null
          beforeInputRef.current = null
          emitDraft()
        }}
        onPaste={(event) => {
          const fileItems = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file')
          const imageFiles = fileItems.map(item => item.getAsFile()).filter((file): file is File => !!file && file.type.startsWith('image/'))
          if (imageFiles.length > 0) {
            event.preventDefault()
            onPasteImages(imageFiles)
            return
          }
          const text = event.clipboardData?.getData('text/plain') || ''
          event.preventDefault()
          if (fileItems.length > 0) {
            if (text) mutate('paste-text', () => insertTextAtSelection(text))
            return
          }
          if (canConvertPasteToBlock(text)) insertPastedText(text)
          else mutate('paste-text', () => insertTextAtSelection(text))
        }}
        onCopy={(event) => {
          const selection = window.getSelection()
          if (!selection?.rangeCount || selection.isCollapsed) return
          event.preventDefault()
          event.clipboardData.setData('text/plain', serializeSelection(selection.getRangeAt(0)))
        }}
        onCut={(event) => {
          const selection = window.getSelection()
          if (!selection?.rangeCount || selection.isCollapsed) return
          event.preventDefault()
          event.clipboardData.setData('text/plain', serializeSelection(selection.getRangeAt(0)))
          mutate('cut', () => selection.getRangeAt(0).deleteContents())
        }}
        onKeyDown={(event) => {
          const nativeEvent = event.nativeEvent
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            historyGroupRef.current = null
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
          const targetChip = event.target instanceof HTMLElement && isChip(event.target) ? event.target : null
          if (targetChip && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            activeChipRef.current = targetChip
            setActiveBlockId(targetChip.dataset.composerPastedTextId || null)
            return
          }
          if (onCommandKeyDown(nativeEvent)) return
          if (event.key === 'Enter' && !nativeEvent.isComposing && !composingRef.current) {
            event.preventDefault()
            mutate('line-break', () => insertTextAtSelection('\n'))
            return
          }
          if (event.key === 'Backspace' || event.key === 'Delete') {
            const chip = adjacentChip(event.key === 'Backspace' ? -1 : 1)
            if (chip) { event.preventDefault(); removeChip(chip) }
          }
        }}
        onClick={(event) => {
          historyGroupRef.current = null
          const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-composer-pasted-text-id]') : null
          if (!chip) return
          activeChipRef.current = chip
          setActiveBlockId(chip.dataset.composerPastedTextId || null)
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur()
        }}
      />
      {activeBlock && (
        <PastedTextModal
          text={activeBlock.text}
          onClose={closeModal}
          onSave={(text) => {
            const chip = activeChipRef.current
            if (!chip) return
            mutate('edit-block', () => {
              const updated = { ...activeBlock, text }
              blockMapRef.current.set(updated.id, updated)
              chip.querySelector<HTMLElement>('.foxwarm-composer-pasted-text-preview')!.textContent = getPastedTextPreview(text)
              chip.querySelector<HTMLElement>('.foxwarm-composer-pasted-text-count')!.textContent = countPastedTextCharacters(text).toLocaleString()
              chip.setAttribute('aria-label', `Edit pasted text, ${countPastedTextCharacters(text)} characters`)
            })
            closeModal()
          }}
          onRestoreToText={(text) => {
            const chip = activeChipRef.current
            if (!chip) return
            mutate('restore-block', () => {
              const textNode = document.createTextNode(text)
              chip.replaceWith(textNode)
              blockMapRef.current.delete(activeBlock.id)
              placeCaret(textNode, textNode.data.length)
            })
            closeModal()
          }}
        />
      )}
    </div>
  )
})

export default memo(InlineComposerEditor, (previous, next) => (
  previous.draftId === next.draftId
  && previous.disabled === next.disabled
  && previous.placeholder === next.placeholder
))

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  canConvertPasteToBlock,
  makeComposerDraft,
  serializeComposerDraft,
  type ComposerDraft,
  type ComposerDraftSegment,
  type ComposerAttachmentSegment,
  type ComposerPastedTextSegment,
} from '../composerDraft'
import { countPastedTextCharacters, getPastedTextPreview } from '../pastedText'
import { PastedTextModal } from './PastedTextBlock'

const MAX_UNDO_ENTRIES = 80
const MAX_UNDO_BYTES = 2_000_000
const TYPING_COALESCE_MS = 750
const CARET_ANCHOR_TEXT = '\u200B'

export interface InlineComposerEditorHandle {
  focus: () => void
  focusEnd: () => void
  flushForSubmit: () => ComposerDraft
  insertAttachments: (files: File[], point?: { x: number; y: number }) => void
  replaceDraft: (draft: ComposerDraft, focusEnd?: boolean) => void
}

interface InlineComposerEditorProps {
  draftId: string
  value: ComposerDraft
  disabled: boolean
  placeholder: string
  onChange: (draft: ComposerDraft) => void
  onBlur: () => void
  onAttachFiles: (files: File[]) => ComposerAttachmentSegment[]
  resolveAttachmentFile: (ref: string) => File | undefined
  onReattachFile: (ref: string, file: File) => void
  onCommandKeyDown: (event: KeyboardEvent) => boolean
}

type HistoryGroup = { kind: string; at: number } | null

type SelectionOffsets = { anchor: number; focus: number }
type EditorState = { draft: ComposerDraft; selection: SelectionOffsets | null }
type DraftSnapshot = EditorState & { size: number }

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
  return node instanceof HTMLElement && (
    node.dataset.composerPastedTextId !== undefined
    || node.dataset.composerAttachmentRef !== undefined
  )
}

function isCaretAnchor(node: Node | null): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.composerCaretAnchor !== undefined
}

function isTrailingNewlineScaffold(node: Node | null): node is HTMLBRElement {
  return node instanceof HTMLBRElement && node.dataset.composerTrailingNewline !== undefined
}

function getCaretAnchor(node: Node | null): HTMLElement | null {
  if (!node) return null
  return isCaretAnchor(node) ? node : node.parentElement?.closest<HTMLElement>('[data-composer-caret-anchor]') || null
}

function removeCaretAnchorSentinel(text: string): string {
  const index = text.indexOf(CARET_ANCHOR_TEXT)
  return index < 0 ? text : `${text.slice(0, index)}${text.slice(index + CARET_ANCHOR_TEXT.length)}`
}

const InlineComposerEditor = forwardRef<InlineComposerEditorHandle, InlineComposerEditorProps>(function InlineComposerEditor({
  draftId,
  value,
  disabled,
  placeholder,
  onChange,
  onBlur,
  onAttachFiles,
  resolveAttachmentFile,
  onReattachFile,
  onCommandKeyDown,
}, forwardedRef) {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const authoritativeDraftRef = useRef(value)
  const blockMapRef = useRef(new Map<string, ComposerPastedTextSegment>())
  const attachmentMapRef = useRef(new Map<string, ComposerAttachmentSegment>())
  const attachmentUrlMapRef = useRef(new Map<string, string>())
  const undoRef = useRef<DraftSnapshot[]>([])
  const redoRef = useRef<DraftSnapshot[]>([])
  const historyGroupRef = useRef<HistoryGroup>(null)
  const beforeInputRef = useRef<EditorState | null>(null)
  const compositionBaseRef = useRef<EditorState | null>(null)
  const composingRef = useRef(false)
  const compositionEndingRef = useRef(false)
  const compositionFinalizeFrameRef = useRef<number | null>(null)
  const lastEmittedRef = useRef('')
  const lastDraftIdRef = useRef('')
  const activeChipRef = useRef<HTMLElement | null>(null)
  const lastSelectionRef = useRef<SelectionOffsets | null>(null)
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [activeAttachmentRef, setActiveAttachmentRef] = useState<string | null>(null)

  const readNodeSegments = useCallback((node: Node, output: ComposerDraftSegment[]) => {
    if (getCaretAnchor(node) || isTrailingNewlineScaffold(node)) return
    if (node.nodeType === Node.TEXT_NODE) {
      output.push({ type: 'text', text: node.nodeValue || '' })
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (isChip(node)) {
      const attachmentRef = node.dataset.composerAttachmentRef
      if (attachmentRef) {
        const attachment = attachmentMapRef.current.get(attachmentRef)
        if (attachment) output.push({ ...attachment })
        return
      }
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
    const editor = editorRef.current
    if (!editor) return makeComposerDraft([])
    const hasCanonicalContent = [...editor.childNodes].some(node => {
      if (isCaretAnchor(node)) return false
      if (isTrailingNewlineScaffold(node)) return false
      if (isChip(node)) return true
      if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').length > 0
      if (node instanceof HTMLElement && node.tagName === 'BR') return false
      return (node.textContent || '').length > 0 || (node instanceof Element && !!node.querySelector('[data-composer-pasted-text-id]'))
    })
    return hasCanonicalContent ? readDraftFromNode(editor) : makeComposerDraft([])
  }, [readDraftFromNode])

  const getNodeUnits = useCallback((node: Node): number => {
    if (getCaretAnchor(node) || isTrailingNewlineScaffold(node)) return 0
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length || 0
    if (isChip(node) || (node instanceof HTMLElement && node.tagName === 'BR')) return 1
    return [...node.childNodes].reduce((sum, child) => sum + getNodeUnits(child), 0)
  }, [])

  const getPointOffset = useCallback((target: Node | null, targetOffset: number): number | null => {
    const editor = editorRef.current
    if (!editor || !target || (target !== editor && !editor.contains(target))) return null
    const targetAnchor = getCaretAnchor(target)
    const normalizedTarget: Node = targetAnchor || target
    let traversed = 0
    let result: number | null = null
    const visit = (node: Node) => {
      if (result !== null) return
      if (node === normalizedTarget) {
        if (isCaretAnchor(node)) {
          result = traversed
          return
        }
        if (node.nodeType === Node.TEXT_NODE) {
          result = traversed + Math.min(targetOffset, node.nodeValue?.length || 0)
        } else {
          const children = [...node.childNodes]
          result = traversed + children.slice(0, Math.min(targetOffset, children.length)).reduce((sum, child) => sum + getNodeUnits(child), 0)
        }
        return
      }
      if (node.nodeType === Node.TEXT_NODE || isChip(node) || (node instanceof HTMLElement && node.tagName === 'BR')) {
        traversed += getNodeUnits(node)
        return
      }
      for (const child of node.childNodes) visit(child)
    }
    visit(editor)
    return result
  }, [getNodeUnits])

  const getSelectionOffsets = useCallback((): SelectionOffsets | null => {
    const selection = window.getSelection()
    if (!selection) return null
    const anchor = getPointOffset(selection.anchorNode, selection.anchorOffset)
    const focus = getPointOffset(selection.focusNode, selection.focusOffset)
    return anchor === null || focus === null ? null : { anchor, focus }
  }, [getPointOffset])

  const getPointAtOffset = useCallback((requestedOffset: number): { node: Node; offset: number } | null => {
    const editor = editorRef.current
    if (!editor) return null
    let remaining = Math.max(0, Math.min(requestedOffset, getNodeUnits(editor)))
    const locate = (parent: Node): { node: Node; offset: number } => {
      const children = [...parent.childNodes]
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        if (isTrailingNewlineScaffold(child)) continue
        if (isCaretAnchor(child)) {
          if (remaining === 0) return { node: child.firstChild || child, offset: child.firstChild ? CARET_ANCHOR_TEXT.length : 0 }
          continue
        }
        if (child.nodeType === Node.TEXT_NODE) {
          const length = child.nodeValue?.length || 0
          if (remaining <= length) return { node: child, offset: remaining }
          remaining -= length
          continue
        }
        if (isChip(child) || (child instanceof HTMLElement && child.tagName === 'BR')) {
          if (remaining === 0) return { node: parent, offset: index }
          remaining -= 1
          if (remaining === 0) return { node: parent, offset: index + 1 }
          continue
        }
        const units = getNodeUnits(child)
        if (remaining <= units) return locate(child)
        remaining -= units
      }
      return { node: parent, offset: children.length }
    }
    return locate(editor)
  }, [getNodeUnits])

  const restoreSelection = useCallback((offsets: SelectionOffsets | null) => {
    const editor = editorRef.current
    if (!editor || !offsets) return false
    const anchor = getPointAtOffset(offsets.anchor)
    const focus = getPointAtOffset(offsets.focus)
    const selection = window.getSelection()
    if (!anchor || !focus || !selection) return false
    editor.focus()
    try {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    } catch {
      const range = document.createRange()
      range.setStart(anchor.node, anchor.offset)
      range.setEnd(focus.node, focus.offset)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return true
  }, [getPointAtOffset])

  const captureEditorState = useCallback((): EditorState => ({
    draft: readDraft(),
    selection: getSelectionOffsets(),
  }), [getSelectionOffsets, readDraft])

  const updateEmptyState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.dataset.empty = serializeComposerDraft(readDraft()).length === 0 ? 'true' : 'false'
  }, [readDraft])

  const updateCompositionPresentation = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const hasCanonicalText = serializeComposerDraft(readDraft()).length > 0
    const hasAnchorText = [...editor.querySelectorAll<HTMLElement>('[data-composer-caret-anchor]')]
      .some(anchor => removeCaretAnchorSentinel(anchor.textContent || '').length > 0)
    editor.dataset.compositionVisible = hasCanonicalText || hasAnchorText ? 'true' : 'false'
  }, [readDraft])

  const emitDraft = useCallback(() => {
    const next = readDraft()
    const editor = editorRef.current
    if (editor && serializeComposerDraft(next).length === 0 && editor.childNodes.length > 0) {
      const restoreEmptyCaret = document.activeElement === editor
      editor.replaceChildren()
      if (restoreEmptyCaret) {
        const range = document.createRange()
        range.setStart(editor, 0)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }
    authoritativeDraftRef.current = next
    lastEmittedRef.current = serializeComposerDraft(next)
    if (editor) editor.dataset.compositionVisible = 'false'
    updateEmptyState()
    onChange(next)
  }, [onChange, readDraft, updateEmptyState])

  const createChip = useCallback((segment: ComposerPastedTextSegment): HTMLElement => {
    blockMapRef.current.set(segment.id, { ...segment })
    const chip = document.createElement('span')
    chip.className = 'foxwarm-composer-pasted-text-chip foxwarm-pasted-text-block mx-0.5 inline-flex max-w-[min(24rem,100%)] items-center gap-1.5 rounded-md border border-fw-accent-border/60 bg-fw-accent-surface px-2 py-0.5 align-middle text-left text-xs leading-5 text-fw-accent shadow-sm hover:bg-fw-accent-surface-strong focus:outline-none focus:ring-2 focus:ring-fw-focus-ring dark:bg-fw-accent-surface-strong/25 dark:hover:bg-fw-accent-surface-strong/40'
    chip.contentEditable = 'false'
    chip.tabIndex = -1
    chip.setAttribute('role', 'group')
    chip.setAttribute('aria-disabled', String(disabled))
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
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'inline-flex min-w-0 items-center gap-1.5 rounded text-left focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    open.tabIndex = disabled ? -1 : 0
    open.disabled = disabled
    open.dataset.composerBlockOpen = 'true'
    open.setAttribute('aria-label', `Edit pasted text, ${countPastedTextCharacters(segment.text)} characters`)
    open.append(icon, preview, count)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ml-1 shrink-0 rounded px-1 text-fw-text-muted hover:text-fw-danger focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    remove.tabIndex = disabled ? -1 : 0
    remove.disabled = disabled
    remove.dataset.composerBlockRemove = 'true'
    remove.setAttribute('aria-label', 'Remove pasted text block')
    remove.textContent = '×'
    chip.append(open, remove)
    return chip
  }, [disabled])

  const createAttachmentChip = useCallback((segment: ComposerAttachmentSegment): HTMLElement => {
    attachmentMapRef.current.set(segment.ref, { ...segment })
    const chip = document.createElement('span')
    chip.className = 'foxwarm-composer-attachment-chip mx-0.5 inline-flex max-w-[min(24rem,100%)] items-center gap-2 rounded-md border border-fw-border bg-fw-surface-raised px-2 py-1 align-middle text-left text-xs leading-5 text-fw-text shadow-sm focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    chip.contentEditable = 'false'
    chip.tabIndex = -1
    chip.setAttribute('role', 'group')
    chip.setAttribute('aria-disabled', String(disabled))
    chip.dataset.composerAttachmentRef = segment.ref
    const file = resolveAttachmentFile(segment.ref)
    if (segment.mimeType.startsWith('image/') && file) {
      const url = URL.createObjectURL(file)
      attachmentUrlMapRef.current.set(segment.ref, url)
      const image = document.createElement('img')
      image.src = url
      image.alt = ''
      image.className = 'h-8 w-8 shrink-0 rounded object-cover'
      chip.append(image)
    } else {
      const icon = document.createElement('span')
      icon.setAttribute('aria-hidden', 'true')
      icon.textContent = file ? '📎' : '⚠'
      chip.append(icon)
    }
    const label = document.createElement('span')
    label.className = 'min-w-0 truncate'
    label.textContent = segment.name
    const info = document.createElement('span')
    info.className = 'shrink-0 text-fw-text-muted'
    info.textContent = file ? `${segment.mimeType || 'file'} · ${segment.size.toLocaleString()} B` : 'Reattach required'
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'inline-flex min-w-0 items-center gap-2 rounded text-left focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    open.tabIndex = disabled ? -1 : 0
    open.disabled = disabled
    open.dataset.composerBlockOpen = 'true'
    open.setAttribute('aria-label', file ? `Attachment ${segment.name}` : `Attachment ${segment.name}, reattach required`)
    while (chip.firstChild) open.append(chip.firstChild)
    open.append(label, info)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ml-1 shrink-0 rounded px-1 text-fw-text-muted hover:text-fw-danger focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    remove.tabIndex = disabled ? -1 : 0
    remove.disabled = disabled
    remove.dataset.composerBlockRemove = 'true'
    remove.setAttribute('aria-label', `Remove attachment ${segment.name}`)
    remove.textContent = '×'
    chip.append(open, remove)
    return chip
  }, [disabled, resolveAttachmentFile])

  const createCaretAnchor = useCallback(() => {
    const anchor = document.createElement('span')
    anchor.className = 'foxwarm-composer-caret-anchor'
    anchor.dataset.composerCaretAnchor = 'true'
    anchor.setAttribute('aria-hidden', 'true')
    anchor.textContent = CARET_ANCHOR_TEXT
    return anchor
  }, [])

  const installCaretAnchors = useCallback((editor: HTMLElement) => {
    for (const scaffold of editor.querySelectorAll<HTMLElement>('[data-composer-trailing-newline]')) scaffold.remove()
    for (const anchor of editor.querySelectorAll<HTMLElement>('[data-composer-caret-anchor]')) anchor.remove()
    editor.normalize()
    const trailingBrowserBreak = editor.lastChild
    if (trailingBrowserBreak instanceof HTMLBRElement) {
      trailingBrowserBreak.remove()
      const withoutTrailingBreak = serializeComposerDraft(readDraftFromNode(editor))
      if (withoutTrailingBreak.length > 0 && !withoutTrailingBreak.endsWith('\n')) editor.append(trailingBrowserBreak)
    }
    const contentNodes = [...editor.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || (node.nodeValue || '').length > 0)
    if (isChip(contentNodes[0])) contentNodes[0].before(createCaretAnchor())
    for (let index = 1; index < contentNodes.length; index += 1) {
      if (isChip(contentNodes[index - 1]) && isChip(contentNodes[index])) contentNodes[index].before(createCaretAnchor())
    }
    if (isChip(contentNodes.at(-1) || null)) editor.append(createCaretAnchor())
    if (serializeComposerDraft(readDraftFromNode(editor)).endsWith('\n')) {
      const scaffold = document.createElement('br')
      scaffold.dataset.composerTrailingNewline = 'true'
      scaffold.setAttribute('aria-hidden', 'true')
      editor.append(scaffold)
    }
  }, [createCaretAnchor, readDraftFromNode])

  const renderDraft = useCallback((draft: ComposerDraft) => {
    const editor = editorRef.current
    if (!editor) return
    blockMapRef.current.clear()
    attachmentMapRef.current.clear()
    for (const url of attachmentUrlMapRef.current.values()) URL.revokeObjectURL(url)
    attachmentUrlMapRef.current.clear()
    const fragment = document.createDocumentFragment()
    for (const segment of draft.segments) {
      fragment.append(segment.type === 'text'
        ? document.createTextNode(segment.text)
        : segment.type === 'pasted-text'
          ? createChip(segment)
          : createAttachmentChip(segment))
    }
    editor.replaceChildren(fragment)
    installCaretAnchors(editor)
    editor.dataset.compositionVisible = 'false'
    updateEmptyState()
  }, [createAttachmentChip, createChip, installCaretAnchors, updateEmptyState])

  const placeCaret = useCallback((container: Node, offset: number) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const range = document.createRange()
    range.setStart(container, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  const reconcileCaretAnchors = useCallback((shouldRestoreSelection = true) => {
    const editor = editorRef.current
    if (!editor) return
    const selection = window.getSelection()
    let desiredSelection = getSelectionOffsets()
    const pointWithinAnchor = (node: Node | null, offset: number) => {
      if (!node) return null
      const anchor = getCaretAnchor(node)
      if (!anchor || !editor.contains(anchor)) return null
      const raw = anchor.textContent || ''
      const rawOffset = node.nodeType === Node.TEXT_NODE ? Math.min(offset, raw.length) : raw.length
      const before = removeCaretAnchorSentinel(raw.slice(0, rawOffset)).length
      const base = getPointOffset(anchor, 0) || 0
      return base + before
    }
    const anchorOffset = pointWithinAnchor(selection?.anchorNode || null, selection?.anchorOffset || 0)
    const focusOffset = pointWithinAnchor(selection?.focusNode || null, selection?.focusOffset || 0)
    if (anchorOffset !== null || focusOffset !== null) {
      desiredSelection = {
        anchor: anchorOffset ?? desiredSelection?.anchor ?? 0,
        focus: focusOffset ?? desiredSelection?.focus ?? 0,
      }
    }
    for (const anchor of editor.querySelectorAll<HTMLElement>('[data-composer-caret-anchor]')) {
      const authoredText = removeCaretAnchorSentinel(anchor.textContent || '')
      if (authoredText) anchor.before(document.createTextNode(authoredText))
    }
    installCaretAnchors(editor)
    if (shouldRestoreSelection) restoreSelection(desiredSelection)
  }, [getPointOffset, getSelectionOffsets, installCaretAnchors, restoreSelection])

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

  const recordHistory = useCallback((base: EditorState, kind: string, coalesce = false) => {
    const current = readDraft()
    if (sameDraft(base.draft, current)) return
    const now = Date.now()
    const previousGroup = historyGroupRef.current
    if (!(coalesce && previousGroup?.kind === kind && now - previousGroup.at <= TYPING_COALESCE_MS)) {
      undoRef.current.push({ draft: cloneDraft(base.draft), selection: base.selection, size: getDraftByteSize(base.draft) })
      trimHistory()
    }
    historyGroupRef.current = { kind, at: now }
    redoRef.current = []
  }, [readDraft, trimHistory])

  const cancelCompositionFinalize = useCallback(() => {
    if (compositionFinalizeFrameRef.current !== null) cancelAnimationFrame(compositionFinalizeFrameRef.current)
    compositionFinalizeFrameRef.current = null
  }, [])

  const finalizeComposition = useCallback(() => {
    cancelCompositionFinalize()
    const base = compositionBaseRef.current
    compositionBaseRef.current = null
    compositionEndingRef.current = false
    composingRef.current = false
    beforeInputRef.current = null
    if (!base || disabledRef.current) {
      updateCompositionPresentation()
      return
    }
    reconcileCaretAnchors()
    recordHistory(base, 'composition')
    emitDraft()
  }, [cancelCompositionFinalize, emitDraft, reconcileCaretAnchors, recordHistory, updateCompositionPresentation])

  const flushForSubmit = useCallback(() => {
    const editor = editorRef.current
    const current = readDraft()
    const hasPendingComposition = composingRef.current || compositionEndingRef.current || compositionBaseRef.current !== null
    const hasCommittedAnchorText = !!editor && [...editor.querySelectorAll<HTMLElement>('[data-composer-caret-anchor]')]
      .some(anchor => removeCaretAnchorSentinel(anchor.textContent || '').length > 0)
    if (!hasPendingComposition && !hasCommittedAnchorText && sameDraft(authoritativeDraftRef.current, current)) {
      return cloneDraft(current)
    }
    cancelCompositionFinalize()
    const base = compositionBaseRef.current || {
      draft: cloneDraft(authoritativeDraftRef.current),
      selection: null,
    }
    compositionBaseRef.current = null
    compositionEndingRef.current = false
    composingRef.current = false
    beforeInputRef.current = null
    if (editor) editor.dataset.compositionVisible = 'false'
    reconcileCaretAnchors(false)
    const next = readDraft()
    if (!sameDraft(base.draft, next)) {
      recordHistory(base, 'composition')
      emitDraft()
    }
    return cloneDraft(next)
  }, [cancelCompositionFinalize, emitDraft, readDraft, reconcileCaretAnchors, recordHistory])

  const applyHistoryDraft = useCallback((snapshot: DraftSnapshot) => {
    renderDraft(snapshot.draft)
    authoritativeDraftRef.current = snapshot.draft
    lastEmittedRef.current = serializeComposerDraft(snapshot.draft)
    onChange(cloneDraft(snapshot.draft))
    if (!restoreSelection(snapshot.selection)) focusEnd()
  }, [focusEnd, onChange, renderDraft, restoreSelection])

  const undo = useCallback(() => {
    const previous = undoRef.current.pop()
    if (!previous) return
    const current = captureEditorState()
    redoRef.current.push({ draft: cloneDraft(current.draft), selection: current.selection, size: getDraftByteSize(current.draft) })
    trimHistory()
    historyGroupRef.current = null
    applyHistoryDraft(previous)
  }, [applyHistoryDraft, captureEditorState, trimHistory])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    const current = captureEditorState()
    undoRef.current.push({ draft: cloneDraft(current.draft), selection: current.selection, size: getDraftByteSize(current.draft) })
    trimHistory()
    historyGroupRef.current = null
    applyHistoryDraft(next)
  }, [applyHistoryDraft, captureEditorState, trimHistory])

  const replaceDraft = useCallback((nextDraft: ComposerDraft, shouldFocusEnd = false) => {
    cancelCompositionFinalize()
    compositionBaseRef.current = null
    compositionEndingRef.current = false
    composingRef.current = false
    beforeInputRef.current = null
    renderDraft(nextDraft)
    authoritativeDraftRef.current = nextDraft
    undoRef.current = []
    redoRef.current = []
    historyGroupRef.current = null
    lastEmittedRef.current = serializeComposerDraft(nextDraft)
    setActiveAttachmentRef(null)
    if (shouldFocusEnd) focusEnd()
  }, [cancelCompositionFinalize, focusEnd, renderDraft])

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
    if (disabledRef.current) return false
    const base = captureEditorState()
    action()
    reconcileCaretAnchors()
    recordHistory(base, kind)
    emitDraft()
    return true
  }, [captureEditorState, emitDraft, reconcileCaretAnchors, recordHistory])

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

  const insertAttachments = useCallback((files: File[], point?: { x: number; y: number }) => {
    const editor = editorRef.current
    if (!editor || files.length === 0) return
    const currentSelection = window.getSelection()
    const hadEditorSelection = !!currentSelection?.rangeCount && editor.contains(currentSelection.getRangeAt(0).commonAncestorContainer)
    const desiredSelection = hadEditorSelection ? getSelectionOffsets() : lastSelectionRef.current
    editor.focus()
    if (point) {
      const caret = document.caretPositionFromPoint?.(point.x, point.y)
      if (caret?.offsetNode && editor.contains(caret.offsetNode)) placeCaret(caret.offsetNode, caret.offset)
      else {
        const rangeAtPoint = document.caretRangeFromPoint?.(point.x, point.y)
        if (rangeAtPoint && editor.contains(rangeAtPoint.startContainer)) placeCaret(rangeAtPoint.startContainer, rangeAtPoint.startOffset)
      }
    } else {
      if (!restoreSelection(desiredSelection)) focusEnd()
    }
    const segments = onAttachFiles(files)
    mutate('insert-attachments', () => {
      const selection = window.getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const fragment = document.createDocumentFragment()
      let last: HTMLElement | null = null
      for (const segment of segments) {
        last = createAttachmentChip(segment)
        fragment.append(last)
      }
      range.insertNode(fragment)
      if (last?.parentNode) placeCaret(last.parentNode, [...last.parentNode.childNodes].indexOf(last) + 1)
    })
  }, [createAttachmentChip, focusEnd, getSelectionOffsets, mutate, onAttachFiles, placeCaret, restoreSelection])

  useImperativeHandle(forwardedRef, () => ({
    focus: () => editorRef.current?.focus(),
    focusEnd,
    flushForSubmit,
    insertAttachments,
    replaceDraft,
  }), [flushForSubmit, focusEnd, insertAttachments, replaceDraft])

  const adjacentChip = useCallback((direction: -1 | 1): HTMLElement | null => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.isCollapsed || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset
    const caretAnchor = getCaretAnchor(container)
    if (caretAnchor) {
      const candidate = direction < 0 ? caretAnchor.previousSibling : caretAnchor.nextSibling
      return isChip(candidate) ? candidate as HTMLElement : null
    }
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
    const draftChanged = lastDraftIdRef.current !== draftId
    if (!draftChanged) return
    const serialized = serializeComposerDraft(value)
    cancelCompositionFinalize()
    compositionBaseRef.current = null
    compositionEndingRef.current = false
    composingRef.current = false
    beforeInputRef.current = null
    renderDraft(value)
    authoritativeDraftRef.current = value
    undoRef.current = []
    redoRef.current = []
    historyGroupRef.current = null
    lastEmittedRef.current = serialized
    lastDraftIdRef.current = draftId
    setActiveBlockId(null)
    setActiveAttachmentRef(null)
  }, [cancelCompositionFinalize, draftId, renderDraft, value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.contentEditable = String(!disabled)
    editor.setAttribute('aria-disabled', String(disabled))
    for (const chip of editor.querySelectorAll<HTMLElement>('[data-composer-pasted-text-id], [data-composer-attachment-ref]')) {
      chip.tabIndex = -1
      chip.setAttribute('aria-disabled', String(disabled))
      for (const button of chip.querySelectorAll<HTMLButtonElement>('button')) {
        button.disabled = disabled
        button.tabIndex = disabled ? -1 : 0
      }
    }
    if (disabled) {
      cancelCompositionFinalize()
      setActiveBlockId(null)
      setActiveAttachmentRef(null)
      activeChipRef.current = null
      beforeInputRef.current = null
      compositionBaseRef.current = null
      compositionEndingRef.current = false
      composingRef.current = false
    }
  }, [cancelCompositionFinalize, disabled])

  useEffect(() => cancelCompositionFinalize, [cancelCompositionFinalize])
  useEffect(() => () => {
    for (const url of attachmentUrlMapRef.current.values()) URL.revokeObjectURL(url)
  }, [])

  const activeBlock = activeBlockId ? blockMapRef.current.get(activeBlockId) || null : null
  const activeAttachment = activeAttachmentRef ? attachmentMapRef.current.get(activeAttachmentRef) || null : null
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
        className="foxwarm-chat-composer-textarea foxwarm-inline-composer-editor relative min-h-[60px] max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-1 text-[16px] leading-6 text-fw-text-strong outline-none focus:ring-0 dark:text-fw-text-strong"
        onBeforeInput={(event) => {
          if (disabled) { event.preventDefault(); return }
          const nativeEvent = event.nativeEvent as InputEvent
          if (composingRef.current || compositionEndingRef.current || nativeEvent.isComposing) {
            beforeInputRef.current = null
            return
          }
          if (nativeEvent.inputType === 'historyUndo') { event.preventDefault(); undo(); return }
          if (nativeEvent.inputType === 'historyRedo') { event.preventDefault(); redo(); return }
          if (nativeEvent.inputType === 'insertParagraph' || nativeEvent.inputType === 'insertLineBreak') {
            event.preventDefault()
            mutate('line-break', () => insertTextAtSelection('\n'))
            return
          }
          beforeInputRef.current = captureEditorState()
        }}
        onInput={(event) => {
          if (disabled) {
            event.preventDefault()
            renderDraft(authoritativeDraftRef.current)
            beforeInputRef.current = null
            return
          }
          const nativeEvent = event.nativeEvent as InputEvent
          if (compositionEndingRef.current) {
            finalizeComposition()
            return
          }
          if (composingRef.current || nativeEvent.isComposing) {
            beforeInputRef.current = null
            updateCompositionPresentation()
            return
          }
          event.currentTarget.dataset.compositionVisible = 'false'
          reconcileCaretAnchors()
          if (beforeInputRef.current) {
            const coalesce = nativeEvent.inputType === 'insertText' || nativeEvent.inputType.startsWith('deleteContent')
            recordHistory(beforeInputRef.current, nativeEvent.inputType || 'input', coalesce)
          }
          beforeInputRef.current = null
          emitDraft()
        }}
        onCompositionStart={(event) => {
          if (disabledRef.current) return
          cancelCompositionFinalize()
          compositionEndingRef.current = false
          composingRef.current = true
          compositionBaseRef.current = captureEditorState()
          event.currentTarget.dataset.compositionVisible = 'false'
        }}
        onCompositionEnd={() => {
          if (disabledRef.current || !compositionBaseRef.current) {
            cancelCompositionFinalize()
            compositionBaseRef.current = null
            compositionEndingRef.current = false
            composingRef.current = false
            updateCompositionPresentation()
            return
          }
          compositionEndingRef.current = true
          beforeInputRef.current = null
          cancelCompositionFinalize()
          compositionFinalizeFrameRef.current = requestAnimationFrame(finalizeComposition)
        }}
        onPaste={(event) => {
          if (disabled) { event.preventDefault(); return }
          const fileItems = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file')
          const files = fileItems.map(item => item.getAsFile()).filter((file): file is File => !!file)
          if (files.length > 0) {
            event.preventDefault()
            insertAttachments(files)
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
          if (disabled) { event.preventDefault(); return }
          const selection = window.getSelection()
          if (!selection?.rangeCount || selection.isCollapsed) return
          event.preventDefault()
          event.clipboardData.setData('text/plain', serializeSelection(selection.getRangeAt(0)))
          mutate('cut', () => selection.getRangeAt(0).deleteContents())
        }}
        onKeyDown={(event) => {
          const nativeEvent = event.nativeEvent
          if (disabled) {
            if ((event.ctrlKey || event.metaKey) && ['x', 'v', 'z', 'y'].includes(event.key.toLowerCase())) event.preventDefault()
            if (['Enter', 'Backspace', 'Delete'].includes(event.key)) event.preventDefault()
            return
          }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            historyGroupRef.current = null
          }
          if (composingRef.current || compositionEndingRef.current || nativeEvent.isComposing) return
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
          const targetChip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-composer-pasted-text-id], [data-composer-attachment-ref]') : null
          if (targetChip && event.target instanceof HTMLButtonElement) return
          const selectionCaretAnchor = getCaretAnchor(window.getSelection()?.anchorNode || null)
          if (event.key === 'Home' && !event.shiftKey && (targetChip || selectionCaretAnchor)) {
            const editor = editorRef.current
            const firstChip = editor ? [...editor.childNodes].find(node => !isCaretAnchor(node) && (node.nodeType !== Node.TEXT_NODE || (node.nodeValue || '').length > 0)) : null
            const leadingAnchor = editor?.querySelector<HTMLElement>(':scope > [data-composer-caret-anchor]:first-child') || null
            if (isChip(firstChip || null) && leadingAnchor) {
              event.preventDefault()
              placeCaret(leadingAnchor.firstChild || leadingAnchor, leadingAnchor.firstChild ? CARET_ANCHOR_TEXT.length : 0)
              return
            }
          }
          if (targetChip && event.key === 'ArrowLeft') {
            const previousAnchor = targetChip.previousSibling
            if (isCaretAnchor(previousAnchor)) {
              event.preventDefault()
              placeCaret(previousAnchor.firstChild || previousAnchor, previousAnchor.firstChild ? CARET_ANCHOR_TEXT.length : 0)
              return
            }
          }
          if (targetChip && event.target === targetChip && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            activeChipRef.current = targetChip
            if (targetChip.dataset.composerAttachmentRef) setActiveAttachmentRef(targetChip.dataset.composerAttachmentRef)
            else setActiveBlockId(targetChip.dataset.composerPastedTextId || null)
            return
          }
          if (onCommandKeyDown(nativeEvent)) return
          if (event.key === 'Enter' && !nativeEvent.isComposing && !composingRef.current) {
            event.preventDefault()
            mutate('line-break', () => insertTextAtSelection('\n'))
            return
          }
          if (event.key === 'Backspace' || event.key === 'Delete') {
            const selection = window.getSelection()
            const editor = editorRef.current
            if (editor && selection?.rangeCount && !selection.isCollapsed && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
              event.preventDefault()
              mutate('delete-selection', () => selection.getRangeAt(0).deleteContents())
              return
            }
            const chip = adjacentChip(event.key === 'Backspace' ? -1 : 1)
            if (chip) { event.preventDefault(); removeChip(chip) }
          }
        }}
        onClick={(event) => {
          historyGroupRef.current = null
          if (disabled) return
          const chip = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-composer-pasted-text-id], [data-composer-attachment-ref]') : null
          if (!chip) return
          if (event.target instanceof Element && event.target.closest('[data-composer-block-remove]')) {
            event.preventDefault()
            event.stopPropagation()
            removeChip(chip)
            return
          }
          if (event.target !== chip && !(event.target instanceof Element && event.target.closest('[data-composer-block-open]'))) return
          activeChipRef.current = chip
          if (chip.dataset.composerAttachmentRef) setActiveAttachmentRef(chip.dataset.composerAttachmentRef)
          else setActiveBlockId(chip.dataset.composerPastedTextId || null)
        }}
        onPointerDown={() => {
          historyGroupRef.current = null
        }}
        onBlur={(event) => {
          lastSelectionRef.current = getSelectionOffsets()
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur()
        }}
        onKeyUp={() => { lastSelectionRef.current = getSelectionOffsets() }}
        onPointerUp={() => { lastSelectionRef.current = getSelectionOffsets() }}
      />
      {!disabled && activeBlock && (
        <PastedTextModal
          text={activeBlock.text}
          onClose={closeModal}
          onSave={(text) => {
            const chip = activeChipRef.current
            if (!chip) return
            if (!mutate('edit-block', () => {
              const updated = { ...activeBlock, text }
              blockMapRef.current.set(updated.id, updated)
              chip.querySelector<HTMLElement>('.foxwarm-composer-pasted-text-preview')!.textContent = getPastedTextPreview(text)
              chip.querySelector<HTMLElement>('.foxwarm-composer-pasted-text-count')!.textContent = countPastedTextCharacters(text).toLocaleString()
              chip.setAttribute('aria-label', `Edit pasted text, ${countPastedTextCharacters(text)} characters`)
            })) return
            closeModal()
          }}
          onRestoreToText={(text) => {
            const chip = activeChipRef.current
            if (!chip) return
            if (!mutate('restore-block', () => {
              const textNode = document.createTextNode(text)
              chip.replaceWith(textNode)
              blockMapRef.current.delete(activeBlock.id)
              placeCaret(textNode, textNode.data.length)
            })) return
            closeModal()
          }}
        />
      )}
      {!disabled && activeAttachment && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveAttachmentRef(null) }}>
          <div role="dialog" aria-modal="true" aria-label="Attachment information" className="w-full max-w-lg rounded-lg border border-fw-border bg-fw-surface p-4 shadow-xl">
            {activeAttachment.mimeType.startsWith('image/') && resolveAttachmentFile(activeAttachment.ref) && (
              <img src={attachmentUrlMapRef.current.get(activeAttachment.ref)} alt={activeAttachment.name} className="mb-3 max-h-72 w-full rounded object-contain" />
            )}
            <div className="font-medium text-fw-text-strong">{activeAttachment.name}</div>
            <div className="mt-1 text-sm text-fw-text-muted">{activeAttachment.mimeType || 'application/octet-stream'} · {activeAttachment.size.toLocaleString()} B</div>
            {!resolveAttachmentFile(activeAttachment.ref) && <div className="mt-2 text-sm text-fw-warning">This attachment must be reattached or removed before sending.</div>}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {!resolveAttachmentFile(activeAttachment.ref) && (
                <label className="cursor-pointer rounded border border-fw-border px-3 py-1.5 text-sm text-fw-text">
                  Reattach
                  <input type="file" className="hidden" onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    const chip = [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-composer-attachment-ref]') || [])]
                      .find(candidate => candidate.dataset.composerAttachmentRef === activeAttachment.ref) || null
                    if (!file || !chip) return
                    onReattachFile(activeAttachment.ref, file)
                    mutate('reattach-file', () => {
                      const updated: ComposerAttachmentSegment = { ...activeAttachment, name: file.name || activeAttachment.name, mimeType: file.type || 'application/octet-stream', size: file.size }
                      attachmentMapRef.current.set(updated.ref, updated)
                      const replacement = createAttachmentChip(updated)
                      chip.replaceWith(replacement)
                      activeChipRef.current = replacement
                    })
                    setActiveAttachmentRef(null)
                  }} />
                </label>
              )}
              <button type="button" className="rounded border border-fw-border px-3 py-1.5 text-sm text-fw-danger" onClick={() => {
                const chip = [...(editorRef.current?.querySelectorAll<HTMLElement>('[data-composer-attachment-ref]') || [])]
                  .find(candidate => candidate.dataset.composerAttachmentRef === activeAttachment.ref) || null
                if (chip) removeChip(chip)
                setActiveAttachmentRef(null)
              }}>Remove</button>
              <button type="button" className="rounded bg-fw-accent px-3 py-1.5 text-sm text-fw-text-inverse" onClick={() => setActiveAttachmentRef(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default memo(InlineComposerEditor, (previous, next) => (
  previous.draftId === next.draftId
  && previous.disabled === next.disabled
  && previous.placeholder === next.placeholder
))

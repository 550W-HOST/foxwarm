import { createPortal } from 'react-dom'
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Annotation, Compartment, EditorSelection, EditorState, Facet, Prec, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { history, insertNewline, isolateHistory, redo, standardKeymap, undo } from '@codemirror/commands'
import {
  canConvertPasteToBlock,
  makePlainComposerDraft,
  type ComposerAttachmentSegment,
  type ComposerDraft,
  type ComposerPastedTextSegment,
} from '../composerDraft'
import {
  addComposerChips,
  composerChipExtensions,
  composerChipField,
  createComposerState,
  documentToDraft,
  getComposerChips,
  insertChipsSpec,
  serializeComposerSegment,
  snapOutsideChips,
  updateComposerChip,
  type ComposerChip,
} from '../composerEditorModel'
import { countPastedTextCharacters, getPastedTextPreview } from '../pastedText'
import { PastedTextModal } from './PastedTextBlock'
import ImagePreviewDialog, { isSafeImagePreviewMime } from './ImagePreviewDialog'

export interface InlineComposerEditorHandle {
  focus: () => void
  focusEnd: () => void
  flushForSubmit: () => ComposerDraft
  insertAttachments: (files: File[], point?: { x: number; y: number }) => void
  openAttachment: (ref: string) => void
  removeAttachment: (ref: string) => void
  replaceDraft: (draft: ComposerDraft, focusEnd?: boolean) => void
  beginTranscription: () => boolean
  updateTranscription: (text: string) => void
  endTranscription: (focus?: boolean) => void
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
  onCompositionPresenceChange?: (hasText: boolean) => void
}

type Transcription = { draftId: string; from: number; to: number; text: string }
type ChipEnvironment = { resolveAttachmentFile: (ref: string) => File | undefined }

/** Marks edits made by the composer itself; they are allowed while the editor is disabled. */
const composerEdit = Annotation.define<boolean>()
const composerDisabled = Facet.define<boolean, boolean>({ combine: values => values.some(Boolean) })
const chipEnvironment = Facet.define<{ current: ChipEnvironment }, { current: ChipEnvironment } | null>({ combine: values => values[0] || null })

const CHIP_SELECTOR = '[data-composer-pasted-text-id], [data-composer-attachment-ref]'

function chipKey(chip: ComposerChip): string {
  return chip.segment.type === 'attachment'
    ? `attachment:${chip.segment.ref}:${chip.revision}`
    : `pasted:${chip.segment.id}:${chip.revision}:${chip.segment.text.length}`
}

class ComposerChipWidget extends WidgetType {
  constructor(readonly chip: ComposerChip, readonly number: number, readonly selected: boolean, readonly disabled: boolean) { super() }

  eq(other: ComposerChipWidget) {
    return chipKey(other.chip) === chipKey(this.chip) && other.chip.segment === this.chip.segment
      && other.number === this.number && other.selected === this.selected && other.disabled === this.disabled
  }

  toDOM(view: EditorView) {
    const segment = this.chip.segment
    const chip = document.createElement('span')
    chip.dataset.composerChipKey = chipKey(this.chip)
    chip.setAttribute('role', 'group')
    chip.tabIndex = -1
    if (segment.type === 'pasted-text') this.renderPastedText(chip, segment)
    else this.renderAttachment(chip, segment, view.state.facet(chipEnvironment)?.current.resolveAttachmentFile(segment.ref))
    this.applyState(chip)
    return chip
  }

  updateDOM(dom: HTMLElement) {
    if (dom.dataset.composerChipKey !== chipKey(this.chip)) return false
    this.applyState(dom)
    return true
  }

  /** Clicks and keys on chip controls belong to the controls, not to the editor. */
  ignoreEvent(event: Event) {
    return event.target instanceof Element && !!event.target.closest('button')
  }

  private renderPastedText(chip: HTMLElement, segment: ComposerPastedTextSegment) {
    const count = countPastedTextCharacters(segment.text)
    chip.className = 'foxwarm-composer-pasted-text-chip foxwarm-pasted-text-block mx-0.5 inline-flex max-w-[min(24rem,100%)] items-center gap-1.5 rounded-md border border-fw-accent-border/60 bg-fw-accent-surface px-2 py-0.5 align-middle text-left text-xs leading-5 text-fw-accent shadow-sm hover:bg-fw-accent-surface-strong focus:outline-none focus:ring-2 focus:ring-fw-focus-ring dark:bg-fw-accent-surface-strong/25 dark:hover:bg-fw-accent-surface-strong/40'
    chip.dataset.composerPastedTextId = segment.id
    const icon = document.createElement('span')
    icon.className = 'shrink-0'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '▤'
    const preview = document.createElement('span')
    preview.className = 'foxwarm-composer-pasted-text-preview min-w-0 truncate'
    preview.textContent = getPastedTextPreview(segment.text)
    const counter = document.createElement('span')
    counter.className = 'foxwarm-composer-pasted-text-count shrink-0 text-fw-text-muted'
    counter.textContent = count.toLocaleString()
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'inline-flex min-w-0 items-center gap-1.5 rounded text-left focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    open.dataset.composerBlockOpen = 'true'
    open.setAttribute('aria-label', `Edit pasted text, ${count} characters`)
    open.append(icon, preview, counter)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ml-1 shrink-0 rounded px-1 text-fw-text-muted hover:text-fw-danger focus:outline-none focus:ring-2 focus:ring-fw-focus-ring'
    remove.dataset.composerBlockRemove = 'true'
    remove.setAttribute('aria-label', 'Remove pasted text block')
    remove.textContent = '×'
    chip.append(open, remove)
  }

  private renderAttachment(chip: HTMLElement, segment: ComposerAttachmentSegment, file: File | undefined) {
    chip.className = 'foxwarm-composer-attachment-chip'
    chip.dataset.composerAttachmentRef = segment.ref
    chip.dataset.attachmentMissing = String(!file)
    chip.title = `${segment.name}${file ? '' : ' · Reattach required'}`
    const open = document.createElement('button')
    open.type = 'button'
    open.dataset.composerBlockOpen = 'true'
    open.setAttribute('aria-label', `Attachment ${segment.name}${file ? '' : ', reattach required'}`)
    chip.append(open)
  }

  private applyState(chip: HTMLElement) {
    chip.setAttribute('aria-disabled', String(this.disabled))
    chip.toggleAttribute('data-composer-block-selected', this.selected)
    for (const button of chip.querySelectorAll('button')) {
      button.disabled = this.disabled
      button.tabIndex = this.disabled ? -1 : 0
    }
    if (this.chip.segment.type === 'attachment') {
      const open = chip.querySelector('button')
      if (open) open.textContent = `FILE ${this.number}`
    }
  }
}

function buildChipDecorations(state: EditorState): DecorationSet {
  const disabled = state.facet(composerDisabled)
  const selections = state.selection.ranges.filter(range => !range.empty)
  let attachmentNumber = 0
  return Decoration.set(getComposerChips(state).map(chip => {
    const number = chip.segment.type === 'attachment' ? ++attachmentNumber : 0
    const selected = selections.some(range => range.from < chip.to && range.to > chip.from)
    return Decoration.replace({ widget: new ComposerChipWidget(chip, number, selected, disabled) }).range(chip.from, chip.to)
  }))
}

const chipDecorations = StateField.define<DecorationSet>({
  create: buildChipDecorations,
  update(decorations, tr) {
    const changed = tr.startState.field(composerChipField) !== tr.state.field(composerChipField)
      || tr.startState.facet(composerDisabled) !== tr.state.facet(composerDisabled)
      || (tr.selection && !tr.startState.selection.eq(tr.state.selection))
    return changed ? buildChipDecorations(tr.state) : decorations.map(tr.changes)
  },
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
})

/** While disabled, only the composer's own edits (transcription, replacement) change the draft. */
const blockDisabledEdits = EditorState.transactionFilter.of(tr => (
  tr.docChanged && tr.startState.facet(composerDisabled) && !tr.annotation(composerEdit) ? [] : tr
))

/** An IME composition is its own undo step, separate from typing before it. */
const isolateComposition = EditorState.transactionExtender.of(tr => (
  tr.annotation(Transaction.userEvent) === 'input.type.compose.start' ? { annotations: isolateHistory.of('before') } : null
))

/**
 * Keeps the caret visible inside the editor's own scroller without scrolling
 * page ancestors. Scroll requests can arrive while the view is updating, when
 * layout can't be read, so the adjustment runs in the next measure phase.
 */
const scrollOwnScroller = EditorView.scrollHandler.of((view, range) => {
  view.requestMeasure({
    key: scrollOwnScroller,
    read() {
      const rect = view.coordsAtPos(range.head, range.assoc || 1)
      if (!rect) return null
      const scroller = view.scrollDOM
      const box = scroller.getBoundingClientRect()
      const content = getComputedStyle(view.contentDOM)
      const top = box.top + parseFloat(content.paddingTop)
      const bottom = box.top + scroller.clientHeight - parseFloat(content.paddingBottom)
      if (rect.bottom > bottom) return rect.bottom - bottom
      if (rect.top < top) return rect.top - top
      return null
    },
    write(delta) {
      if (delta) view.scrollDOM.scrollTop += delta
    },
  })
  return true
})

const composerTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', maxHeight: '200px', overflowX: 'hidden', overflowY: 'auto' },
  // minWidth lets wrapped content shrink to the scroller, so chips can cap at the line width.
  '.cm-content': { boxSizing: 'border-box', padding: '8px 16px', minHeight: '60px', minWidth: '0', fontFamily: 'inherit' },
  '.cm-line': { padding: '0' },
})

function disabledExtensions(disabled: boolean): Extension {
  return [
    composerDisabled.of(disabled),
    EditorView.editable.of(!disabled),
    EditorState.readOnly.of(disabled),
    EditorView.contentAttributes.of({ 'aria-disabled': String(disabled) }),
  ]
}

// The composer owns Enter (send key or exact newline); during IME composition
// Enter belongs to the input method.
const editingKeymap = keymap.of(standardKeymap.filter(binding => binding.key !== 'Enter'))

function placeholderAttributes(placeholder: string): Extension {
  return EditorView.contentAttributes.of(placeholder ? { 'data-placeholder': placeholder, 'aria-placeholder': placeholder } : {})
}

const historyBindings = keymap.of([
  { key: 'Mod-z', run: undo, preventDefault: true },
  { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
  { key: 'Mod-Shift-z', run: redo, preventDefault: true },
])

function newPastedTextId(): string {
  return globalThis.crypto?.randomUUID?.() || `paste-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  onCompositionPresenceChange,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const callbacksRef = useRef({ onChange, onAttachFiles, onCommandKeyDown, onCompositionPresenceChange, resolveAttachmentFile })
  callbacksRef.current = { onChange, onAttachFiles, onCommandKeyDown, onCompositionPresenceChange, resolveAttachmentFile }
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const draftIdRef = useRef(draftId)
  draftIdRef.current = draftId
  const disabledCompartment = useRef(new Compartment()).current
  const placeholderCompartment = useRef(new Compartment()).current
  const lastEmittedRef = useRef('')
  const suppressEmitRef = useRef(false)
  const compositionPresenceRef = useRef(false)
  const compositionFrameRef = useRef<number | null>(null)
  const transcriptionRef = useRef<Transcription | null>(null)
  const caretWasPlacedRef = useRef(false)
  const focusAfterTranscriptionRef = useRef(false)
  const openChipKeyRef = useRef<string | null>(null)
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [activeAttachmentRef, setActiveAttachmentRef] = useState<string | null>(null)

  const setCompositionPresence = useCallback((present: boolean) => {
    if (compositionPresenceRef.current === present) return
    compositionPresenceRef.current = present
    callbacksRef.current.onCompositionPresenceChange?.(present)
  }, [])

  const emit = useCallback((view: EditorView) => {
    if (suppressEmitRef.current) return
    const draft = documentToDraft(view.state)
    const key = JSON.stringify(draft)
    if (key === lastEmittedRef.current) return
    lastEmittedRef.current = key
    callbacksRef.current.onChange(draft)
  }, [])

  // Interim IME text is not emitted. Composition can end without a later
  // transaction (or without DOM composition events, as with EditContext), so
  // the committed draft is emitted from the first frame after it ends.
  const scheduleCompositionFlush = useCallback((view: EditorView) => {
    if (compositionFrameRef.current !== null) return
    compositionFrameRef.current = requestAnimationFrame(() => {
      compositionFrameRef.current = null
      if (viewRef.current !== view) return
      if (view.composing) { scheduleCompositionFlush(view); return }
      setCompositionPresence(false)
      emit(view)
    })
  }, [emit, setCompositionPresence])

  const insertChips = useCallback((view: EditorView, segments: (ComposerAttachmentSegment | ComposerPastedTextSegment)[], range = view.state.selection.main) => {
    if (segments.length === 0) return
    view.dispatch({ ...insertChipsSpec(view.state, segments, range.from, range.to), annotations: isolateHistory.of('full') })
  }, [])

  const removeChip = useCallback((view: EditorView, chip: ComposerChip) => {
    if (disabledRef.current) return
    view.dispatch({
      changes: { from: chip.from, to: chip.to },
      selection: EditorSelection.cursor(chip.from),
      userEvent: 'delete.chip',
      annotations: isolateHistory.of('full'),
    })
    view.focus()
  }, [])

  const openChip = useCallback((chip: ComposerChip) => {
    if (disabledRef.current) return
    openChipKeyRef.current = chip.segment.type === 'attachment' ? chip.segment.ref : chip.segment.id
    if (chip.segment.type === 'attachment') setActiveAttachmentRef(chip.segment.ref)
    else setActiveBlockId(chip.segment.id)
  }, [])

  const insertAttachmentsAt = useCallback((view: EditorView, files: File[], point?: { x: number; y: number }) => {
    if (disabledRef.current || files.length === 0) return
    let range = caretWasPlacedRef.current ? view.state.selection.main : EditorSelection.cursor(view.state.doc.length)
    if (point) {
      const pos = view.posAtCoords(point, false)
      range = EditorSelection.cursor(snapOutsideChips(view.state, pos))
    }
    const segments = callbacksRef.current.onAttachFiles(files)
    view.focus()
    insertChips(view, segments, range)
  }, [insertChips])

  const createState = useCallback((draft: ComposerDraft) => createComposerState(draft, [
    composerChipExtensions,
    chipDecorations,
    chipEnvironment.of(callbacksRef as { current: ChipEnvironment }),
    disabledCompartment.of(disabledExtensions(disabledRef.current)),
    placeholderCompartment.of(placeholderAttributes(placeholderRef.current)),
    EditorView.contentAttributes.of(view => ({ 'data-empty': view.state.doc.length === 0 ? 'true' : 'false' })),
    blockDisabledEdits,
    history(),
    isolateComposition,
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        if (view.state.facet(composerDisabled)) {
          const key = event.key.toLowerCase()
          return ((event.ctrlKey || event.metaKey) && ['x', 'v', 'z', 'y'].includes(key)) || ['Enter', 'Backspace', 'Delete'].includes(event.key)
        }
        if (event.isComposing || view.composing) return false
        if (callbacksRef.current.onCommandKeyDown(event)) return true
        if (event.key !== 'Enter') return false
        insertNewline(view)
        return true
      },
      beforeinput(event, view) {
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false
        if (!view.state.facet(composerDisabled)) (event.inputType === 'historyUndo' ? undo : redo)(view)
        return true
      },
      paste(event, view) {
        if (view.state.facet(composerDisabled)) return true
        const fileItems = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file')
        const files = fileItems.map(item => item.getAsFile()).filter((file): file is File => !!file)
        if (files.length > 0) {
          insertAttachmentsAt(view, files)
          return true
        }
        const text = event.clipboardData?.getData('text/plain') || ''
        if (fileItems.length > 0) {
          if (text) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true })
          return true
        }
        if (!canConvertPasteToBlock(text)) return false
        insertChips(view, [{ type: 'pasted-text', id: newPastedTextId(), text }])
        return true
      },
      // Dropped files become attachments through the composer's drop target;
      // dragging a selection that contains chips would turn them into text.
      drop(event) {
        return !!event.dataTransfer?.files.length
      },
      // A collapsed selection copies nothing, as in a plain text field.
      copy(_event, view) {
        return view.state.selection.ranges.every(range => range.empty)
      },
      cut(_event, view) {
        return view.state.selection.ranges.every(range => range.empty)
      },
      dragstart(_event, view) {
        const chips = getComposerChips(view.state)
        return view.state.selection.ranges.some(range => chips.some(chip => range.from < chip.to && range.to > chip.from))
      },
      focus() {
        caretWasPlacedRef.current = true
        return false
      },
    })),
    editingKeymap,
    historyBindings,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      role: 'textbox',
      'aria-label': 'Message',
      'aria-multiline': 'true',
      spellcheck: 'true',
      autocorrect: 'on',
      autocapitalize: 'sentences',
      class: 'foxwarm-chat-composer-textarea text-[16px] leading-6 text-fw-text-strong dark:text-fw-text-strong',
    }),
    EditorView.editorAttributes.of({ class: 'foxwarm-inline-composer-editor' }),
    scrollOwnScroller,
    composerTheme,
    EditorView.updateListener.of(update => {
      const owner = transcriptionRef.current
      if (owner && update.docChanged) {
        owner.from = update.changes.mapPos(owner.from, -1)
        owner.to = Math.max(owner.from, update.changes.mapPos(owner.to, 1))
      }
      if (update.view.composing) {
        setCompositionPresence(update.state.doc.toString().trim().length > 0)
        if (update.docChanged) scheduleCompositionFlush(update.view)
        return
      }
      if (update.docChanged || update.transactions.some(tr => tr.effects.some(effect => effect.is(updateComposerChip) || effect.is(addComposerChips)))) {
        setCompositionPresence(false)
        emit(update.view)
      }
    }),
  ]), [disabledCompartment, emit, insertAttachmentsAt, insertChips, placeholderCompartment, scheduleCompositionFlush, setCompositionPresence])

  const resetState = useCallback((draft: ComposerDraft) => {
    const view = viewRef.current
    if (!view) return
    transcriptionRef.current = null
    view.setState(createState(draft))
    lastEmittedRef.current = JSON.stringify(documentToDraft(view.state))
    setCompositionPresence(false)
    setActiveBlockId(null)
    setActiveAttachmentRef(null)
  }, [createState, setCompositionPresence])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({ parent: host, state: createState(value) })
    viewRef.current = view
    lastEmittedRef.current = JSON.stringify(documentToDraft(view.state))
    return () => {
      if (compositionFrameRef.current !== null) cancelAnimationFrame(compositionFrameRef.current)
      compositionFrameRef.current = null
      view.destroy()
      viewRef.current = null
    }
    // The view is created once; later drafts arrive through draftId changes or replaceDraft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mountedDraftIdRef = useRef(draftId)
  useEffect(() => {
    if (mountedDraftIdRef.current === draftId) return
    mountedDraftIdRef.current = draftId
    caretWasPlacedRef.current = false
    focusAfterTranscriptionRef.current = false
    resetState(value)
  }, [draftId, resetState, value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: disabledCompartment.reconfigure(disabledExtensions(disabled)) })
    if (disabled) {
      setActiveBlockId(null)
      setActiveAttachmentRef(null)
    } else if (focusAfterTranscriptionRef.current) {
      focusAfterTranscriptionRef.current = false
      view.focus()
    }
  }, [disabled, disabledCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderCompartment.reconfigure(placeholderAttributes(placeholder)) })
  }, [placeholder, placeholderCompartment])

  const flushForSubmit = useCallback((): ComposerDraft => {
    const view = viewRef.current
    if (!view) return makePlainComposerDraft()
    setCompositionPresence(false)
    emit(view)
    return documentToDraft(view.state)
  }, [emit, setCompositionPresence])

  const focusEnd = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    view.focus()
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), scrollIntoView: true })
  }, [])

  const findChip = useCallback((key: string): ComposerChip | null => {
    const view = viewRef.current
    if (!view) return null
    return getComposerChips(view.state).find(chip => (chip.segment.type === 'attachment' ? chip.segment.ref : chip.segment.id) === key) || null
  }, [])

  const beginTranscription = useCallback(() => {
    const view = viewRef.current
    if (!view || disabledRef.current || transcriptionRef.current) return false
    // A pointer on the microphone may have blurred an in-progress composition.
    flushForSubmit()
    const pos = caretWasPlacedRef.current ? view.state.selection.main.head : view.state.doc.length
    transcriptionRef.current = { draftId: draftIdRef.current, from: pos, to: pos, text: '' }
    return true
  }, [flushForSubmit])

  const updateTranscription = useCallback((text: string) => {
    const view = viewRef.current
    const owner = transcriptionRef.current
    if (!view || !owner || owner.draftId !== draftIdRef.current || owner.text === text) return
    // Partial results stay out of history; endTranscription records one step.
    view.dispatch({
      changes: { from: owner.from, to: owner.to, insert: text },
      annotations: [composerEdit.of(true), Transaction.addToHistory.of(false)],
    })
    owner.to = owner.from + text.length
    owner.text = text
  }, [])

  const endTranscription = useCallback((shouldFocus = false) => {
    const view = viewRef.current
    const owner = transcriptionRef.current
    if (!view || !owner || owner.draftId !== draftIdRef.current) return
    transcriptionRef.current = null
    if (owner.text) {
      suppressEmitRef.current = true
      try {
        view.dispatch({ changes: { from: owner.from, to: owner.to }, annotations: [composerEdit.of(true), Transaction.addToHistory.of(false)] })
      } finally {
        suppressEmitRef.current = false
      }
      view.dispatch({
        changes: { from: owner.from, insert: owner.text },
        selection: EditorSelection.cursor(owner.from + owner.text.length),
        userEvent: 'input.transcription',
        annotations: [composerEdit.of(true), isolateHistory.of('full')],
      })
    }
    if (shouldFocus) {
      if (disabledRef.current) focusAfterTranscriptionRef.current = true
      else view.focus()
    }
  }, [])

  useImperativeHandle(forwardedRef, () => ({
    focus: () => viewRef.current?.focus(),
    focusEnd,
    flushForSubmit,
    insertAttachments: (files, point) => {
      const view = viewRef.current
      if (view) insertAttachmentsAt(view, files, point)
    },
    openAttachment: ref => {
      const chip = findChip(ref)
      if (chip) openChip(chip)
    },
    removeAttachment: ref => {
      const view = viewRef.current
      const chip = findChip(ref)
      if (view && chip) removeChip(view, chip)
    },
    replaceDraft: (draft, shouldFocusEnd = false) => {
      resetState(draft)
      if (shouldFocusEnd) focusEnd()
    },
    beginTranscription,
    updateTranscription,
    endTranscription,
  }), [beginTranscription, endTranscription, findChip, flushForSubmit, focusEnd, insertAttachmentsAt, openChip, removeChip, resetState, updateTranscription])

  const handleClick = useCallback((event: React.MouseEvent) => {
    const view = viewRef.current
    const button = event.target instanceof Element ? event.target.closest('button') : null
    const element = button?.closest<HTMLElement>(CHIP_SELECTOR)
    if (!view || !button || !element || disabledRef.current) return
    const chip = findChip(element.dataset.composerAttachmentRef || element.dataset.composerPastedTextId || '')
    if (!chip) return
    event.preventDefault()
    if (button.dataset.composerBlockRemove) removeChip(view, chip)
    else openChip(chip)
  }, [findChip, openChip, removeChip])

  const closeModal = useCallback(() => {
    setActiveBlockId(null)
    setActiveAttachmentRef(null)
    const key = openChipKeyRef.current
    requestAnimationFrame(() => {
      const button = [...(hostRef.current?.querySelectorAll<HTMLElement>(CHIP_SELECTOR) || [])]
        .find(element => (element.dataset.composerAttachmentRef || element.dataset.composerPastedTextId) === key)
        ?.querySelector<HTMLButtonElement>('[data-composer-block-open]')
      if (button) button.focus()
      else viewRef.current?.focus()
    })
  }, [])

  // Replaces a chip's text and metadata as one undoable step.
  const replaceChip = useCallback((chip: ComposerChip, segment: ComposerPastedTextSegment) => {
    const view = viewRef.current
    if (!view || disabledRef.current) return false
    const text = serializeComposerSegment(segment)
    view.dispatch({
      changes: { from: chip.from, to: chip.to, insert: text },
      effects: addComposerChips.of([{ from: chip.from, to: chip.from + text.length, segment, revision: chip.revision + 1 }]),
      selection: EditorSelection.cursor(chip.from + text.length),
      userEvent: 'input.chip',
      annotations: isolateHistory.of('full'),
    })
    return true
  }, [])

  const activeBlockChip = activeBlockId ? findChip(activeBlockId) : null
  const activeBlock = activeBlockChip?.segment.type === 'pasted-text' ? activeBlockChip.segment : null
  const activeAttachmentChip = activeAttachmentRef ? findChip(activeAttachmentRef) : null
  const activeAttachment = activeAttachmentChip?.segment.type === 'attachment' ? activeAttachmentChip.segment : null
  const activeAttachmentFile = activeAttachment ? resolveAttachmentFile(activeAttachment.ref) : undefined
  const activeImageSrc = useMemo(
    () => activeAttachment && activeAttachmentFile && isSafeImagePreviewMime(activeAttachment.mimeType) ? URL.createObjectURL(activeAttachmentFile) : undefined,
    [activeAttachment, activeAttachmentFile],
  )
  useEffect(() => () => { if (activeImageSrc) URL.revokeObjectURL(activeImageSrc) }, [activeImageSrc])

  return (
    <div
      className="relative"
      onClick={handleClick}
      onKeyDown={(event) => {
        // Chip controls are outside CodeMirror's input handling; keep history keys working there.
        const view = viewRef.current
        const key = event.key.toLowerCase()
        if (!view || !(event.target instanceof HTMLButtonElement) || !(event.ctrlKey || event.metaKey) || (key !== 'z' && key !== 'y')) return
        event.preventDefault()
        // The focused chip may be removed by this step; keep focus in the editor.
        view.focus()
        if (key === 'y' || event.shiftKey) redo(view)
        else undo(view)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur()
      }}
    >
      <div ref={hostRef} />
      {!disabled && activeBlock && activeBlockChip && (
        <PastedTextModal
          text={activeBlock.text}
          onClose={closeModal}
          onSave={(text) => {
            const chip = findChip(activeBlock.id)
            if (chip && replaceChip(chip, { ...activeBlock, text })) closeModal()
          }}
          onRestoreToText={(text) => {
            const view = viewRef.current
            const chip = findChip(activeBlock.id)
            if (!view || !chip || disabledRef.current) return
            view.dispatch({
              changes: { from: chip.from, to: chip.to, insert: text },
              selection: EditorSelection.cursor(chip.from + text.length),
              userEvent: 'input.chip',
              annotations: isolateHistory.of('full'),
            })
            setActiveBlockId(null)
            requestAnimationFrame(() => viewRef.current?.focus())
          }}
        />
      )}
      {!disabled && activeAttachment && activeImageSrc && <ImagePreviewDialog src={activeImageSrc} mimeType={activeAttachment.mimeType} title={activeAttachment.name} onClose={() => setActiveAttachmentRef(null)} />}
      {!disabled && activeAttachment && activeAttachmentChip && !activeImageSrc && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveAttachmentRef(null) }}>
          <div role="dialog" aria-modal="true" aria-label="Attachment information" className="w-full max-w-lg rounded-lg border border-fw-border bg-fw-surface p-4 shadow-xl">
            <div className="font-medium text-fw-text-strong">{activeAttachment.name}</div>
            <div className="mt-1 text-sm text-fw-text-muted">{activeAttachment.mimeType || 'application/octet-stream'} · {activeAttachment.size.toLocaleString()} B</div>
            {!activeAttachmentFile && <div className="mt-2 text-sm text-fw-warning">This attachment must be reattached or removed before sending.</div>}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {!activeAttachmentFile && (
                <label className="cursor-pointer rounded border border-fw-border px-3 py-1.5 text-sm text-fw-text">
                  Reattach
                  <input type="file" className="hidden" onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    const view = viewRef.current
                    if (!file || !view || disabledRef.current) return
                    onReattachFile(activeAttachment.ref, file)
                    const segment: ComposerAttachmentSegment = { ...activeAttachment, name: file.name || activeAttachment.name, mimeType: file.type || 'application/octet-stream', size: file.size }
                    view.dispatch({
                      effects: updateComposerChip.of({ from: activeAttachmentChip.from, segment, previous: activeAttachment }),
                      annotations: isolateHistory.of('full'),
                    })
                    setActiveAttachmentRef(null)
                  }} />
                </label>
              )}
              <button type="button" className="rounded border border-fw-border px-3 py-1.5 text-sm text-fw-danger" onClick={() => {
                const view = viewRef.current
                if (view) removeChip(view, activeAttachmentChip)
                setActiveAttachmentRef(null)
              }}>Remove</button>
              <button type="button" className="rounded bg-fw-accent px-3 py-1.5 text-sm text-fw-accent-text" onClick={() => setActiveAttachmentRef(null)}>Close</button>
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  )
})

export default memo(InlineComposerEditor, (previous, next) => (
  previous.draftId === next.draftId
  && previous.disabled === next.disabled
  && previous.placeholder === next.placeholder
))

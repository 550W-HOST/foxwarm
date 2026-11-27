// CodeMirror state model for the composer.
//
// The document text is the canonical serialized draft (`serializeComposerDraft`).
// Pasted-text and attachment segments are chips: ranges in `composerChipField` that own
// the exact wrapper/marker text and carry the segment metadata. Only ranges in
// the field are chips, so hand-typed or pasted wrapper syntax stays ordinary
// text. A change never edits inside a chip: it is widened to the whole chip,
// and a chip whose text is touched no longer exists. History restores removed
// chips and metadata through inverted effects.
import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'
import {
  makeComposerDraft,
  serializeComposerDraft,
  type ComposerAttachmentSegment,
  type ComposerDraft,
  type ComposerDraftSegment,
  type ComposerPastedTextSegment,
} from './composerDraft'

export type ComposerChipSegment = ComposerAttachmentSegment | ComposerPastedTextSegment
export type ComposerChip = { from: number; to: number; segment: ComposerChipSegment; revision: number }
type ChipUpdate = { from: number; segment: ComposerChipSegment; previous: ComposerChipSegment }

export function serializeComposerSegment(segment: ComposerDraftSegment): string {
  return serializeComposerDraft({ version: 1, segments: [segment] })
}

/** Adds chips; positions refer to the document after the carrying transaction. */
export const addComposerChips = StateEffect.define<ComposerChip[]>({
  map: (chips, mapping) => chips
    .map(chip => ({ ...chip, from: mapping.mapPos(chip.from, 1), to: mapping.mapPos(chip.to, -1) }))
    .filter(chip => chip.from < chip.to),
})

/** Replaces a chip's metadata without changing its text (attachment reattachment). */
export const updateComposerChip = StateEffect.define<ChipUpdate>({
  map: (update, mapping) => ({ ...update, from: mapping.mapPos(update.from, 1) }),
})

export const composerChipField = StateField.define<readonly ComposerChip[]>({
  create: () => [],
  update(chips, tr) {
    let next = chips
    if (tr.docChanged) {
      next = next
        .filter(chip => {
          let touched = false
          tr.changes.iterChangedRanges((fromA, toA) => { if (fromA < chip.to && toA > chip.from) touched = true })
          return !touched
        })
        .map(chip => ({ ...chip, from: tr.changes.mapPos(chip.from, 1), to: tr.changes.mapPos(chip.to, -1) }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addComposerChips)) {
        const added = effect.value.filter(chip => chip.to <= tr.state.doc.length
          && tr.state.doc.sliceString(chip.from, chip.to) === serializeComposerSegment(chip.segment))
        next = [...next.filter(existing => !added.some(chip => chip.from < existing.to && chip.to > existing.from)), ...added]
      } else if (effect.is(updateComposerChip)) {
        next = next.map(chip => chip.from === effect.value.from
          && serializeComposerSegment(effect.value.segment) === serializeComposerSegment(chip.segment)
          ? { ...chip, segment: effect.value.segment, revision: chip.revision + 1 }
          : chip)
      }
    }
    return next === chips ? chips : [...next].sort((left, right) => left.from - right.from)
  },
})

export function getComposerChips(state: EditorState): readonly ComposerChip[] {
  return state.field(composerChipField)
}

export function findChipAt(state: EditorState, pos: number): ComposerChip | null {
  return getComposerChips(state).find(chip => pos > chip.from && pos < chip.to) || null
}

/** Moves a position that falls inside a chip to the nearer chip edge. */
export function snapOutsideChips(state: EditorState, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, state.doc.length))
  const chip = findChipAt(state, clamped)
  if (!chip) return clamped
  return clamped - chip.from < chip.to - clamped ? chip.from : chip.to
}

const keepChipsAtomic = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr
  const chips = getComposerChips(tr.startState)
  if (chips.length === 0) return tr
  let widened = false
  const specs: { from: number; to: number; insert: string }[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let from = fromA
    let to = toA
    for (const chip of chips) {
      const reachesInside = from === to ? from > chip.from && from < chip.to : from < chip.to && to > chip.from
      if (reachesInside && (from > chip.from || to < chip.to)) {
        from = Math.min(from, chip.from)
        to = Math.max(to, chip.to)
        widened = true
      }
    }
    specs.push({ from, to, insert: inserted.toString() })
  })
  if (!widened) return tr
  const merged: typeof specs = []
  for (const spec of specs.sort((left, right) => left.from - right.from)) {
    const last = merged.at(-1)
    if (last && spec.from <= last.to) {
      last.to = Math.max(last.to, spec.to)
      last.insert += spec.insert
    } else merged.push({ ...spec })
  }
  const changes = tr.startState.changes(merged)
  const last = merged.at(-1)!
  const spec: TransactionSpec = {
    changes,
    selection: EditorSelection.cursor(changes.mapPos(last.from, -1) + last.insert.length),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  }
  const userEvent = tr.annotation(Transaction.userEvent)
  if (userEvent) spec.userEvent = userEvent
  return spec
})

const chipHistory = invertedEffects.of(tr => {
  const inverted: StateEffect<unknown>[] = []
  if (tr.docChanged) {
    const restored: ComposerChip[] = []
    const before = getComposerChips(tr.startState)
    tr.changes.iterChangedRanges((fromA, toA) => {
      for (const chip of before) if (chip.from >= fromA && chip.to <= toA && chip.from < chip.to) restored.push(chip)
    })
    if (restored.length) inverted.push(addComposerChips.of(restored))
  }
  for (const effect of tr.effects) {
    if (effect.is(updateComposerChip)) inverted.push(updateComposerChip.of({ from: effect.value.from, segment: effect.value.previous, previous: effect.value.segment }))
  }
  return inverted
})

/** State-level extensions: chip tracking, atomic edits and chip-aware history inversion. */
export const composerChipExtensions: Extension = [
  // Keep CR/CRLF exactly as pasted; only LF separates editor lines.
  EditorState.lineSeparator.of('\n'),
  composerChipField,
  keepChipsAtomic,
  chipHistory,
]

export function draftToDocument(draft: ComposerDraft): { text: string; chips: ComposerChip[] } {
  let text = ''
  const chips: ComposerChip[] = []
  for (const segment of draft.segments) {
    const piece = serializeComposerSegment(segment)
    if (segment.type !== 'text') chips.push({ from: text.length, to: text.length + piece.length, segment: { ...segment }, revision: 0 })
    text += piece
  }
  return { text, chips }
}

export function documentToDraft(state: EditorState): ComposerDraft {
  const segments: ComposerDraftSegment[] = []
  let cursor = 0
  for (const chip of getComposerChips(state)) {
    if (chip.from > cursor) segments.push({ type: 'text', text: state.doc.sliceString(cursor, chip.from) })
    segments.push({ ...chip.segment })
    cursor = chip.to
  }
  if (cursor < state.doc.length) segments.push({ type: 'text', text: state.doc.sliceString(cursor) })
  return makeComposerDraft(segments)
}

/** Creates a state for `draft` with the caret at its end. */
export function createComposerState(draft: ComposerDraft, extensions: Extension): EditorState {
  const { text, chips } = draftToDocument(draft)
  const initial = EditorState.create({ doc: text, extensions, selection: EditorSelection.cursor(text.length) })
  return chips.length === 0 ? initial : initial.update({ effects: addComposerChips.of(chips), annotations: Transaction.addToHistory.of(false) }).state
}

/** Transaction spec replacing `from..to` with chips for `segments`, caret after them. */
export function insertChipsSpec(state: EditorState, segments: ComposerChipSegment[], from: number, to: number): TransactionSpec {
  const start = snapOutsideChips(state, Math.min(from, to))
  const end = snapOutsideChips(state, Math.max(from, to))
  let text = ''
  const chips: ComposerChip[] = []
  for (const segment of segments) {
    const piece = serializeComposerSegment(segment)
    chips.push({ from: start + text.length, to: start + text.length + piece.length, segment: { ...segment }, revision: 0 })
    text += piece
  }
  return {
    changes: { from: start, to: end, insert: text },
    effects: addComposerChips.of(chips),
    selection: EditorSelection.cursor(start + text.length),
    scrollIntoView: true,
    userEvent: 'input.paste',
  }
}

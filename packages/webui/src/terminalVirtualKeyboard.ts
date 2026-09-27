export type TerminalKeyboardPage = 'abc' | 'symbols' | 'more'
export type TerminalKeyboardMode = 'web' | 'native' | 'collapsed'
export type ShiftState = 'off' | 'armed' | 'locked'

export interface TerminalKeyModifiers {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface TerminalEncodingModes {
  applicationCursorKeysMode: boolean
}

export type TerminalVirtualKey =
  | { kind: 'printable'; value: string }
  | { kind: 'special'; value: 'Escape' | 'Tab' | 'Backspace' | 'Enter' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Insert' | 'Delete' | `F${number}` }

export const TERMINAL_KEYBOARD_STORAGE_KEY = 'foxwarm.terminalKeyboard.mode'
export const TERMINAL_KEY_REPEAT_DELAY_MS = 350
export const TERMINAL_KEY_REPEAT_INTERVAL_MS = 60
export const TERMINAL_SHIFT_DOUBLE_TAP_MS = 320

export const REPEATING_TERMINAL_KEYS = new Set<TerminalVirtualKey['value']>([
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowUp',
  'ArrowDown',
  'ArrowRight',
  'PageUp',
  'PageDown',
])

const FUNCTION_KEY_TILDE_CODES: Record<number, number> = {
  5: 15,
  6: 17,
  7: 18,
  8: 19,
  9: 20,
  10: 21,
  11: 23,
  12: 24,
}

export function terminalModifierParameter(modifiers: TerminalKeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
}

function controlCharacter(value: string): string | null {
  if (value.length !== 1) return null
  const code = value.charCodeAt(0)
  if (code === 32) return '\x00'
  if (code === 63) return '\x7f'
  if ((code >= 64 && code <= 95) || (code >= 97 && code <= 122)) {
    return String.fromCharCode(code & 0x1f)
  }
  return null
}

function withAlt(sequence: string, alt: boolean): string {
  return alt ? `\x1b${sequence}` : sequence
}

function encodeCursorKey(
  suffix: 'A' | 'B' | 'C' | 'D' | 'H' | 'F',
  modifiers: TerminalKeyModifiers,
  modes: TerminalEncodingModes,
): string {
  const parameter = terminalModifierParameter(modifiers)
  if (parameter !== 1) return `\x1b[1;${parameter}${suffix}`
  return `\x1b${modes.applicationCursorKeysMode ? 'O' : '['}${suffix}`
}

function encodeTildeKey(code: number, modifiers: TerminalKeyModifiers): string {
  const parameter = terminalModifierParameter(modifiers)
  return parameter === 1 ? `\x1b[${code}~` : `\x1b[${code};${parameter}~`
}

export function encodeTerminalVirtualKey(
  key: TerminalVirtualKey,
  modifiers: TerminalKeyModifiers,
  modes: TerminalEncodingModes,
): string {
  if (key.kind === 'printable') {
    let sequence = key.value
    if (modifiers.ctrl) sequence = controlCharacter(sequence) ?? sequence
    return withAlt(sequence, modifiers.alt)
  }

  switch (key.value) {
    case 'Escape':
      return withAlt('\x1b', modifiers.alt)
    case 'Tab':
      return withAlt(modifiers.shift ? '\x1b[Z' : '\t', modifiers.alt)
    case 'Backspace':
      return withAlt(modifiers.ctrl ? '\x08' : '\x7f', modifiers.alt)
    case 'Enter':
      return withAlt('\r', modifiers.alt)
    case 'ArrowUp':
      return encodeCursorKey('A', modifiers, modes)
    case 'ArrowDown':
      return encodeCursorKey('B', modifiers, modes)
    case 'ArrowRight':
      return encodeCursorKey('C', modifiers, modes)
    case 'ArrowLeft':
      return encodeCursorKey('D', modifiers, modes)
    case 'Home':
      return encodeCursorKey('H', modifiers, modes)
    case 'End':
      return encodeCursorKey('F', modifiers, modes)
    case 'PageUp':
      return encodeTildeKey(5, modifiers)
    case 'PageDown':
      return encodeTildeKey(6, modifiers)
    case 'Insert':
      return encodeTildeKey(2, modifiers)
    case 'Delete':
      return encodeTildeKey(3, modifiers)
    default: {
      const match = /^F(\d+)$/.exec(key.value)
      const number = match ? Number(match[1]) : 0
      if (number >= 1 && number <= 4) {
        const suffix = ['P', 'Q', 'R', 'S'][number - 1]
        const parameter = terminalModifierParameter(modifiers)
        return parameter === 1 ? `\x1bO${suffix}` : `\x1b[1;${parameter}${suffix}`
      }
      const tildeCode = FUNCTION_KEY_TILDE_CODES[number]
      if (tildeCode) return encodeTildeKey(tildeCode, modifiers)
      throw new Error(`Unsupported terminal key: ${key.value}`)
    }
  }
}

export function nextShiftState(current: ShiftState, elapsedSinceLastTap: number): ShiftState {
  if (current === 'locked') return 'off'
  if (current === 'armed') {
    return elapsedSinceLastTap <= TERMINAL_SHIFT_DOUBLE_TAP_MS ? 'locked' : 'off'
  }
  return 'armed'
}

export function defaultTerminalKeyboardMode(coarsePointer: boolean): TerminalKeyboardMode {
  return coarsePointer ? 'web' : 'collapsed'
}

export function terminalKeyboardViewportOverlap(normalBottom: number, visibleBottom: number): number {
  return Math.max(0, normalBottom - visibleBottom)
}

export function loadTerminalKeyboardMode(storage: Pick<Storage, 'getItem'>, coarsePointer: boolean): TerminalKeyboardMode {
  const stored = storage.getItem(TERMINAL_KEYBOARD_STORAGE_KEY)
  return stored === 'web' || stored === 'native' || stored === 'collapsed'
    ? stored
    : defaultTerminalKeyboardMode(coarsePointer)
}

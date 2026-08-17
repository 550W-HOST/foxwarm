import { useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  REPEATING_TERMINAL_KEYS,
  TERMINAL_KEYBOARD_STORAGE_KEY,
  TERMINAL_KEY_REPEAT_DELAY_MS,
  TERMINAL_KEY_REPEAT_INTERVAL_MS,
  encodeTerminalVirtualKey,
  loadTerminalKeyboardMode,
  nextShiftState,
  terminalKeyboardViewportOverlap,
  type ShiftState,
  type TerminalKeyboardMode,
  type TerminalKeyboardPage,
  type TerminalKeyModifiers,
  type TerminalVirtualKey,
} from '../terminalVirtualKeyboard'
import './TerminalVirtualKeyboard.css'

type KeyDefinition = {
  id: string
  label: string
  shiftedLabel?: string
  key?: TerminalVirtualKey
  action?: 'shift' | 'symbols' | 'abc'
  className?: string
}

const ABC_ROWS: KeyDefinition[][] = [
  [...'qwertyuiop'].map(value => ({ id: `abc-${value}`, label: value, shiftedLabel: value.toUpperCase(), key: { kind: 'printable', value } })),
  [...'asdfghjkl'].map(value => ({ id: `abc-${value}`, label: value, shiftedLabel: value.toUpperCase(), key: { kind: 'printable', value } })),
  [
    { id: 'abc-shift', label: 'Shift', action: 'shift', className: 'wide' },
    ...[...'zxcvbnm'].map(value => ({ id: `abc-${value}`, label: value, shiftedLabel: value.toUpperCase(), key: { kind: 'printable' as const, value } })),
    { id: 'abc-backspace', label: '⌫', key: { kind: 'special', value: 'Backspace' }, className: 'wide' },
  ],
  [
    { id: 'abc-symbols', label: '123', action: 'symbols', className: 'page' },
    { id: 'abc-comma', label: ',', shiftedLabel: '<', key: { kind: 'printable', value: ',' } },
    { id: 'abc-space', label: 'Space', key: { kind: 'printable', value: ' ' }, className: 'space' },
    { id: 'abc-period', label: '.', shiftedLabel: '>', key: { kind: 'printable', value: '.' } },
    { id: 'abc-enter', label: 'Enter', key: { kind: 'special', value: 'Enter' }, className: 'enter' },
  ],
]

const SYMBOL_ROWS: KeyDefinition[][] = [
  [...'1234567890'].map((value, index) => ({ id: `symbol-${value}`, label: value, shiftedLabel: [...'!@#$%^&*()'][index], key: { kind: 'printable', value } })),
  [
    ['-', '_'], ['/', '\\'], [':', '|'], [';', '~'], ['(', '<'], [')', '>'], ['$', '['], ['&', ']'], ['@', '{'], ['"', '}'],
  ].map(([label, shiftedLabel]) => ({ id: `symbol-${label}`, label, shiftedLabel, key: { kind: 'printable', value: label } })),
  [
    { id: 'symbol-shift', label: 'Shift', action: 'shift', className: 'wide' },
    ...[
      ['.', '`'], [',', '^'], ['?', '+'], ['!', '='], ["'", '*'], ['[', '%'], [']', '#'],
    ].map(([label, shiftedLabel]) => ({ id: `symbol-lower-${label}`, label, shiftedLabel, key: { kind: 'printable' as const, value: label } })),
    { id: 'symbol-backspace', label: '⌫', key: { kind: 'special', value: 'Backspace' }, className: 'wide' },
  ],
  [
    { id: 'symbol-abc', label: 'ABC', action: 'abc', className: 'page' },
    { id: 'symbol-comma', label: ',', shiftedLabel: '<', key: { kind: 'printable', value: ',' } },
    { id: 'symbol-space', label: 'Space', key: { kind: 'printable', value: ' ' }, className: 'space' },
    { id: 'symbol-period', label: '.', shiftedLabel: '>', key: { kind: 'printable', value: '.' } },
    { id: 'symbol-enter', label: 'Enter', key: { kind: 'special', value: 'Enter' }, className: 'enter' },
  ],
]

const MORE_ROWS: KeyDefinition[][] = [
  ['Home', 'End', 'PageUp', 'PageDown'].map(value => ({ id: `more-${value}`, label: value === 'PageUp' ? 'PgUp' : value === 'PageDown' ? 'PgDn' : value, key: { kind: 'special' as const, value: value as 'Home' | 'End' | 'PageUp' | 'PageDown' } })),
  [
    { id: 'more-insert', label: 'Insert', key: { kind: 'special', value: 'Insert' } },
    { id: 'more-delete', label: 'Delete', key: { kind: 'special', value: 'Delete' } },
    { id: 'more-copy', label: 'Copy' },
    { id: 'more-paste', label: 'Paste' },
  ],
  Array.from({ length: 6 }, (_, index) => ({ id: `more-f${index + 1}`, label: `F${index + 1}`, key: { kind: 'special' as const, value: `F${index + 1}` as `F${number}` } })),
  Array.from({ length: 6 }, (_, index) => ({ id: `more-f${index + 7}`, label: `F${index + 7}`, key: { kind: 'special' as const, value: `F${index + 7}` as `F${number}` } })),
]

const SPECIAL_KEYS: KeyDefinition[] = [
  { id: 'special-escape', label: 'Esc', key: { kind: 'special', value: 'Escape' } },
  { id: 'special-tab', label: 'Tab', key: { kind: 'special', value: 'Tab' } },
  { id: 'special-ctrl', label: 'Ctrl' },
  { id: 'special-alt', label: 'Alt' },
  { id: 'special-left', label: '←', key: { kind: 'special', value: 'ArrowLeft' } },
  { id: 'special-up', label: '↑', key: { kind: 'special', value: 'ArrowUp' } },
  { id: 'special-down', label: '↓', key: { kind: 'special', value: 'ArrowDown' } },
  { id: 'special-right', label: '→', key: { kind: 'special', value: 'ArrowRight' } },
  { id: 'special-more', label: 'More' },
]

interface TerminalVirtualKeyboardProps {
  terminal: Terminal | null
  resetToken: string
}

type ActiveGesture = {
  pointerId: number
  id: string
  element: HTMLButtonElement
  definition: KeyDefinition
  key?: TerminalVirtualKey
  modifiers: TerminalKeyModifiers
  repeat: boolean
  repeated: boolean
  emitted: boolean
  cancelled: boolean
  delayTimer?: number
  intervalTimer?: number
}

function ReleaseActionButton({ children, onActivate }: { children: React.ReactNode; onActivate: () => void }) {
  const [pressed, setPressed] = useState(false)
  const pointerRef = useRef<{ id: number; element: HTMLButtonElement; cancelled: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const clearPointer = () => {
    pointerRef.current = null
    setPressed(false)
  }

  const cancelPointer = () => {
    if (pointerRef.current) suppressClickRef.current = true
    clearPointer()
  }

  return (
    <button
      type="button"
      className={pressed ? 'pressed' : ''}
      onPointerDown={event => {
        event.preventDefault()
        pointerRef.current = { id: event.pointerId, element: event.currentTarget, cancelled: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        setPressed(true)
      }}
      onPointerMove={event => {
        const pointer = pointerRef.current
        if (!pointer || pointer.id !== event.pointerId) return
        const rect = pointer.element.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
          pointer.cancelled = true
          setPressed(false)
        }
      }}
      onPointerUp={event => {
        const pointer = pointerRef.current
        if (!pointer || pointer.id !== event.pointerId) return
        event.preventDefault()
        suppressClickRef.current = true
        const valid = !pointer.cancelled
        clearPointer()
        if (valid) onActivate()
      }}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={cancelPointer}
      onClick={event => {
        if (event.detail !== 0 && suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        if (event.detail === 0) onActivate()
      }}
    >
      {children}
    </button>
  )
}

export default function TerminalVirtualKeyboard({ terminal, resetToken }: TerminalVirtualKeyboardProps) {
  const coarsePointer = useMemo(() => window.matchMedia('(pointer: coarse)').matches, [])
  const [mode, setMode] = useState<TerminalKeyboardMode>(() => {
    try { return loadTerminalKeyboardMode(localStorage, coarsePointer) } catch { return coarsePointer ? 'web' : 'collapsed' }
  })
  const [page, setPage] = useState<TerminalKeyboardPage>('abc')
  const [returnPage, setReturnPage] = useState<'abc' | 'symbols'>('abc')
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const [shift, setShift] = useState<ShiftState>('off')
  const [pressed, setPressed] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [nativeOffset, setNativeOffset] = useState(0)
  const keyboardRef = useRef<HTMLDivElement | null>(null)
  const shiftTapAtRef = useRef(0)
  const gestureRef = useRef<ActiveGesture | null>(null)
  const suppressClickRef = useRef<string | null>(null)
  const modifiersRef = useRef({ ctrl, alt, shift })

  const updateModifiersRef = (next: Partial<{ ctrl: boolean; alt: boolean; shift: ShiftState }>) => {
    modifiersRef.current = { ...modifiersRef.current, ...next }
  }

  const clearModifiers = () => {
    setCtrl(false); setAlt(false); setShift('off')
    modifiersRef.current = { ctrl: false, alt: false, shift: 'off' }
  }

  const finishOneShotModifiers = () => {
    const current = modifiersRef.current
    const nextShift = current.shift === 'armed' ? 'off' : current.shift
    setCtrl(false); setAlt(false); setShift(nextShift)
    modifiersRef.current = { ctrl: false, alt: false, shift: nextShift }
  }

  const applyInputMode = (nextMode: TerminalKeyboardMode, focusNative: boolean) => {
    const textarea = terminal?.textarea
    if (!textarea) return
    if (nextMode === 'native') {
      textarea.readOnly = false
      textarea.inputMode = 'text'
      if (focusNative) terminal?.focus()
    } else if (nextMode === 'collapsed' && !coarsePointer) {
      textarea.readOnly = false
      textarea.inputMode = 'text'
    } else {
      terminal?.blur()
      textarea.blur()
      textarea.inputMode = 'none'
      textarea.readOnly = true
    }
  }

  const changeMode = (nextMode: TerminalKeyboardMode) => {
    stopGesture(true)
    clearModifiers()
    setMode(nextMode)
    try { localStorage.setItem(TERMINAL_KEYBOARD_STORAGE_KEY, nextMode) } catch {}
    applyInputMode(nextMode, nextMode === 'native')
  }

  useEffect(() => {
    clearModifiers()
    stopGesture(true)
    applyInputMode(mode, false)
  }, [resetToken, terminal])

  useEffect(() => {
    applyInputMode(mode, false)
  }, [mode, terminal])

  useEffect(() => {
    if (mode !== 'native') { setNativeOffset(0); return }
    const update = () => {
      const viewport = window.visualViewport
      const keyboard = keyboardRef.current
      if (!viewport || !keyboard) { setNativeOffset(0); return }
      setNativeOffset(terminalKeyboardViewportOverlap(
        keyboard.getBoundingClientRect().bottom,
        viewport.offsetTop + viewport.height,
      ))
    }
    update()
    const resizeObserver = new ResizeObserver(update)
    if (keyboardRef.current) resizeObserver.observe(keyboardRef.current)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      resizeObserver.disconnect()
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [mode])

  useEffect(() => () => stopGesture(true), [])

  const currentModifiers = (): TerminalKeyModifiers => ({
    ctrl: modifiersRef.current.ctrl,
    alt: modifiersRef.current.alt,
    shift: modifiersRef.current.shift !== 'off',
  })

  const emitKey = (key: TerminalVirtualKey, modifiers: TerminalKeyModifiers) => {
    if (!terminal) return false
    terminal.input(encodeTerminalVirtualKey(key, modifiers, {
      applicationCursorKeysMode: terminal.modes.applicationCursorKeysMode,
    }), true)
    return true
  }

  const resolvedKey = (definition: KeyDefinition): TerminalVirtualKey | undefined => {
    if (!definition.key) return undefined
    if (definition.key.kind === 'printable' && modifiersRef.current.shift !== 'off' && definition.shiftedLabel) {
      return { kind: 'printable', value: definition.shiftedLabel }
    }
    return definition.key
  }

  function stopGesture(cancelled: boolean) {
    const gesture = gestureRef.current
    if (!gesture) return
    if (gesture.delayTimer !== undefined) window.clearTimeout(gesture.delayTimer)
    if (gesture.intervalTimer !== undefined) window.clearInterval(gesture.intervalTimer)
    gesture.cancelled ||= cancelled
    if (gesture.cancelled) suppressClickRef.current = gesture.id
    if (gesture.emitted && !gesture.cancelled) finishOneShotModifiers()
    gestureRef.current = null
    setPressed(null)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>, definition: KeyDefinition) => {
    const key = resolvedKey(definition)
    if (definition.key && (!key || !terminal)) return
    event.preventDefault()
    stopGesture(true)
    const repeat = key ? REPEATING_TERMINAL_KEYS.has(key.value) : false
    const gesture: ActiveGesture = {
      pointerId: event.pointerId,
      id: definition.id,
      element: event.currentTarget,
      definition,
      key,
      modifiers: currentModifiers(),
      repeat,
      repeated: false,
      emitted: false,
      cancelled: false,
    }
    gestureRef.current = gesture
    setPressed(definition.id)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (repeat) {
      gesture.delayTimer = window.setTimeout(() => {
        if (gestureRef.current !== gesture || gesture.cancelled) return
        gesture.repeated = true
        if (!gesture.key) return
        gesture.emitted = emitKey(gesture.key, gesture.modifiers)
        gesture.intervalTimer = window.setInterval(() => {
          if (gestureRef.current === gesture && !gesture.cancelled && gesture.key) emitKey(gesture.key, gesture.modifiers)
        }, TERMINAL_KEY_REPEAT_INTERVAL_MS)
      }, TERMINAL_KEY_REPEAT_DELAY_MS)
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const rect = gesture.element.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      stopGesture(true)
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    suppressClickRef.current = gesture.id
    if (!gesture.cancelled && !gesture.repeated) {
      if (gesture.key) gesture.emitted = emitKey(gesture.key, gesture.modifiers)
      else activateDefinition(gesture.definition)
    }
    stopGesture(false)
  }

  const activateDefinition = (definition: KeyDefinition) => {
    if (definition.action === 'shift') {
      const now = performance.now()
      const next = nextShiftState(modifiersRef.current.shift, now - shiftTapAtRef.current)
      shiftTapAtRef.current = now
      setShift(next); updateModifiersRef({ shift: next })
      return
    }
    if (definition.action === 'symbols') { setPage('symbols'); return }
    if (definition.action === 'abc') { setPage('abc'); return }
    if (definition.id === 'special-ctrl') { const next = !modifiersRef.current.ctrl; setCtrl(next); updateModifiersRef({ ctrl: next }); return }
    if (definition.id === 'special-alt') { const next = !modifiersRef.current.alt; setAlt(next); updateModifiersRef({ alt: next }); return }
    if (definition.id === 'special-more') {
      if (page === 'more') setPage(returnPage)
      else { setReturnPage(page); setPage('more') }
      return
    }
    if (definition.id === 'more-copy') { void copySelection(); return }
    if (definition.id === 'more-paste') { void pasteClipboard(); return }
    const key = resolvedKey(definition)
    if (key && emitKey(key, currentModifiers())) finishOneShotModifiers()
  }

  const onClick = (event: React.MouseEvent<HTMLButtonElement>, definition: KeyDefinition) => {
    if (event.detail !== 0 && suppressClickRef.current === definition.id) { suppressClickRef.current = null; return }
    if (event.detail !== 0 && definition.key) return
    activateDefinition(definition)
  }

  const copySelection = async () => {
    const selection = terminal?.getSelection() ?? ''
    if (!selection) { setFeedback('Nothing selected'); return }
    if (!navigator.clipboard?.writeText) { setFeedback('Copy unavailable'); return }
    try { await navigator.clipboard.writeText(selection); setFeedback('Copied') } catch { setFeedback('Copy blocked') }
  }

  const pasteClipboard = async () => {
    if (!terminal || !navigator.clipboard?.readText) { setFeedback('Paste unavailable'); return }
    try {
      const text = await navigator.clipboard.readText()
      if (!text) { setFeedback('Clipboard is empty'); return }
      terminal.paste(text)
      setFeedback('Pasted')
    } catch { setFeedback('Paste blocked') }
  }

  const shifted = shift !== 'off'
  const rows = page === 'more' ? MORE_ROWS : page === 'symbols' ? SYMBOL_ROWS : ABC_ROWS
  const renderButton = (definition: KeyDefinition) => {
    const label = shifted && definition.shiftedLabel ? definition.shiftedLabel : definition.label
    const isShift = definition.action === 'shift'
    const armed = definition.id === 'special-ctrl' ? ctrl : definition.id === 'special-alt' ? alt : isShift && shift !== 'off'
    return (
      <button
        key={definition.id}
        data-key-id={definition.id}
        type="button"
        className={`terminal-key ${definition.className ?? ''} ${pressed === definition.id ? 'pressed' : ''} ${armed ? 'armed' : ''} ${isShift && shift === 'locked' ? 'locked' : ''}`}
        aria-label={definition.label === '⌫' ? 'Backspace' : label}
        aria-pressed={definition.id === 'special-ctrl' || definition.id === 'special-alt' || isShift || definition.id === 'special-more' ? (definition.id === 'special-more' ? page === 'more' : armed) : undefined}
        onPointerDown={event => onPointerDown(event, definition)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => stopGesture(true)}
        onLostPointerCapture={() => { if (gestureRef.current?.id === definition.id) stopGesture(true) }}
        onClick={event => onClick(event, definition)}
      >
        {label}
      </button>
    )
  }

  return (
    <div ref={keyboardRef} className={`terminal-keyboard terminal-keyboard-${mode}`} data-terminal-keyboard-mode={mode}>
      {mode === 'web' && (
        <>
          <div className="terminal-special-bar" aria-label="Terminal special keys">
            {SPECIAL_KEYS.map(renderButton)}
          </div>
          <div className="terminal-keyboard-body" data-page={page}>
            {rows.map((row, index) => <div className={`terminal-key-row row-${index + 1}`} key={`${page}-${index}`}>{row.map(renderButton)}</div>)}
          </div>
        </>
      )}
      <div className="terminal-keyboard-footer" style={mode === 'native' ? { transform: `translateY(-${nativeOffset}px)` } : undefined}>
        <div className="terminal-keyboard-mode-actions" role="group" aria-label="Terminal keyboard mode">
          {mode !== 'web' && <ReleaseActionButton onActivate={() => changeMode('web')}>Web keyboard</ReleaseActionButton>}
          {mode !== 'native' && <ReleaseActionButton onActivate={() => changeMode('native')}>Native keyboard</ReleaseActionButton>}
          {mode === 'native' && <ReleaseActionButton onActivate={() => applyInputMode('native', true)}>Open keyboard</ReleaseActionButton>}
          {mode !== 'collapsed' && <ReleaseActionButton onActivate={() => changeMode('collapsed')}>Collapse</ReleaseActionButton>}
        </div>
        <div className="terminal-keyboard-feedback" role="status" aria-live="polite">{feedback}</div>
      </div>
    </div>
  )
}

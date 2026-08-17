import { useEffect, useMemo, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { ChevronDown, Keyboard } from 'lucide-react'
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
  action?: 'shift' | 'symbols' | 'abc' | 'return' | 'native' | 'collapse'
  icon?: 'native' | 'collapse'
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
    { id: 'abc-native', label: 'Native keyboard', action: 'native', icon: 'native', className: 'utility compact' },
    { id: 'abc-space', label: 'Space', key: { kind: 'printable', value: ' ' }, className: 'space' },
    { id: 'abc-collapse', label: 'Collapse keyboard', action: 'collapse', icon: 'collapse', className: 'utility compact' },
    { id: 'abc-enter', label: 'Enter', key: { kind: 'special', value: 'Enter' }, className: 'enter utility' },
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
    { id: 'symbol-native', label: 'Native keyboard', action: 'native', icon: 'native', className: 'utility compact' },
    { id: 'symbol-space', label: 'Space', key: { kind: 'printable', value: ' ' }, className: 'space' },
    { id: 'symbol-collapse', label: 'Collapse keyboard', action: 'collapse', icon: 'collapse', className: 'utility compact' },
    { id: 'symbol-enter', label: 'Enter', key: { kind: 'special', value: 'Enter' }, className: 'enter utility' },
  ],
]

const MORE_ROWS: KeyDefinition[][] = [
  ['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].map(value => ({ id: `more-${value}`, label: value === 'PageUp' ? 'PgUp' : value === 'PageDown' ? 'PgDn' : value, key: { kind: 'special' as const, value: value as 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Insert' | 'Delete' }, className: 'utility' })),
  [
    { id: 'more-copy', label: 'Copy', className: 'utility' },
    { id: 'more-paste', label: 'Paste', className: 'utility' },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `more-f${index + 1}`, label: `F${index + 1}`, key: { kind: 'special' as const, value: `F${index + 1}` as `F${number}` } })),
  ],
  Array.from({ length: 8 }, (_, index) => ({ id: `more-f${index + 5}`, label: `F${index + 5}`, key: { kind: 'special' as const, value: `F${index + 5}` as `F${number}` } })),
  [
    { id: 'more-return', label: 'Return page', action: 'return', className: 'page' },
    { id: 'more-native', label: 'Native keyboard', action: 'native', icon: 'native', className: 'utility compact' },
    { id: 'more-space', label: 'Space', key: { kind: 'printable', value: ' ' }, className: 'space' },
    { id: 'more-collapse', label: 'Collapse keyboard', action: 'collapse', icon: 'collapse', className: 'utility compact' },
    { id: 'more-enter', label: 'Enter', key: { kind: 'special', value: 'Enter' }, className: 'enter utility' },
  ],
]

const SPECIAL_KEYS: KeyDefinition[] = [
  { id: 'special-escape', label: 'Esc', key: { kind: 'special', value: 'Escape' }, className: 'utility' },
  { id: 'special-tab', label: 'Tab', key: { kind: 'special', value: 'Tab' }, className: 'utility' },
  { id: 'special-ctrl', label: 'Ctrl', className: 'utility' },
  { id: 'special-alt', label: 'Alt', className: 'utility' },
  { id: 'special-left', label: '←', key: { kind: 'special', value: 'ArrowLeft' }, className: 'utility' },
  { id: 'special-up', label: '↑', key: { kind: 'special', value: 'ArrowUp' }, className: 'utility' },
  { id: 'special-down', label: '↓', key: { kind: 'special', value: 'ArrowDown' }, className: 'utility' },
  { id: 'special-right', label: '→', key: { kind: 'special', value: 'ArrowRight' }, className: 'utility' },
  { id: 'special-more', label: 'More', className: 'utility' },
]

interface TerminalVirtualKeyboardProps {
  terminal: Terminal | null
  resetToken: string
  mode?: TerminalKeyboardMode
  onModeChange?: (mode: TerminalKeyboardMode) => void
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

function ReleaseActionButton({
  children,
  onActivate,
  ariaLabel,
  className,
  style,
}: {
  children: React.ReactNode
  onActivate: () => void
  ariaLabel?: string
  className?: string
  style?: React.CSSProperties
}) {
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
      aria-label={ariaLabel}
      className={`${className ?? ''} ${pressed ? 'pressed' : ''}`}
      style={style}
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

export function TerminalKeyboardHeaderControl({
  nativeMode,
  onActivate,
}: {
  nativeMode: boolean
  onActivate: () => void
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (!nativeMode) { setOffset(0); return }
    const update = () => {
      const viewport = window.visualViewport
      const anchor = anchorRef.current
      if (!viewport || !anchor) { setOffset(0); return }
      setOffset(terminalKeyboardViewportOverlap(
        anchor.getBoundingClientRect().bottom,
        viewport.offsetTop + viewport.height,
      ))
    }
    update()
    const resizeObserver = new ResizeObserver(update)
    if (anchorRef.current) resizeObserver.observe(anchorRef.current)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      resizeObserver.disconnect()
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [nativeMode])

  return (
    <span ref={anchorRef} className="terminal-keyboard-header-anchor">
      <ReleaseActionButton
        ariaLabel="Show Web keyboard"
        className="terminal-keyboard-header-control"
        onActivate={onActivate}
        style={nativeMode ? { transform: `translateY(-${offset}px)` } : undefined}
      >
        <Keyboard aria-hidden="true" size={16} strokeWidth={1.9} />
      </ReleaseActionButton>
    </span>
  )
}

export default function TerminalVirtualKeyboard({ terminal, resetToken, mode: controlledMode, onModeChange }: TerminalVirtualKeyboardProps) {
  const coarsePointer = useMemo(() => window.matchMedia('(pointer: coarse)').matches, [])
  const [internalMode, setInternalMode] = useState<TerminalKeyboardMode>(() => {
    try { return loadTerminalKeyboardMode(localStorage, coarsePointer) } catch { return coarsePointer ? 'web' : 'collapsed' }
  })
  const mode = controlledMode ?? internalMode
  const [page, setPage] = useState<TerminalKeyboardPage>('abc')
  const [returnPage, setReturnPage] = useState<'abc' | 'symbols'>('abc')
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  const [shift, setShift] = useState<ShiftState>('off')
  const [pressed, setPressed] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
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
    if (controlledMode === undefined) setInternalMode(nextMode)
    onModeChange?.(nextMode)
    try { localStorage.setItem(TERMINAL_KEYBOARD_STORAGE_KEY, nextMode) } catch {}
    applyInputMode(nextMode, nextMode === 'native')
  }

  useEffect(() => {
    clearModifiers()
    stopGesture(true)
    applyInputMode(mode, false)
  }, [resetToken, terminal])

  useEffect(() => {
    clearModifiers()
    applyInputMode(mode, false)
  }, [mode, terminal])

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
    if (definition.action === 'return') { setPage(returnPage); return }
    if (definition.action === 'native') { changeMode('native'); return }
    if (definition.action === 'collapse') { changeMode('collapsed'); return }
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
    const baseLabel = definition.action === 'return' ? (returnPage === 'abc' ? 'ABC' : '123') : definition.label
    const label = shifted && definition.shiftedLabel ? definition.shiftedLabel : baseLabel
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
        {definition.icon === 'native'
          ? <Keyboard aria-hidden="true" size={18} strokeWidth={1.9} />
          : definition.icon === 'collapse'
            ? <ChevronDown aria-hidden="true" size={19} strokeWidth={2.1} />
            : label}
      </button>
    )
  }

  return (
    <div className={`terminal-keyboard terminal-keyboard-${mode}`} data-terminal-keyboard-mode={mode}>
      {mode === 'web' && (
        <>
          <div className="terminal-special-bar" aria-label="Terminal special keys">
            {SPECIAL_KEYS.map(renderButton)}
          </div>
          <div className="terminal-keyboard-body" data-page={page}>
            {rows.map((row, index) => <div className={`terminal-key-row row-${index + 1}`} key={`${page}-${index}`}>{row.map(renderButton)}</div>)}
          </div>
          {feedback && <div className="terminal-keyboard-feedback" role="status" aria-live="polite">{feedback}</div>}
        </>
      )}
    </div>
  )
}

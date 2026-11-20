import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, SquareTerminal, Trash2 } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { API_BASE_PATH, makeWebSocketUrl } from '../config'
import { buildTerminalCreateRequest, findTerminalForTarget, normalizeTerminalTarget } from '../terminalTarget'
import { loadTerminalKeyboardMode, TERMINAL_KEYBOARD_STORAGE_KEY, type TerminalKeyboardMode } from '../terminalVirtualKeyboard'
import {
  attachTerminalPinchZoom,
  clampTerminalFontSize,
  loadTerminalFontSize,
  persistTerminalFontSize,
  terminalFontSizeShortcutDelta,
  TERMINAL_DEFAULT_FONT_SIZE,
} from '../terminalPinchZoom'
import TerminalVirtualKeyboard, { TerminalKeyboardHeaderControl } from './TerminalVirtualKeyboard'
import { attachTerminalUnloadGuard, copyTerminalText, isApplePlatform, terminalShortcutAction } from '../terminalShortcuts'
import { requestTerminalKill, terminalKillConfirmation } from '../terminalRegistry'
import { terminalThemeFromSnapshot } from '../theme/integrations'
import { getThemeSnapshot, THEME_CHANGED_EVENT } from '../theme/runtime'

type TerminalStatus = 'connecting' | 'ready' | 'disconnected' | 'closed' | 'error'

type TerminalInfo = {
  id: string
  nodeId: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  pid: number
}

interface TerminalViewProps {
  initialCwd?: string
  initialNodeId?: string
  initialTerminalId?: string
  createMode?: 'new' | 'reuse'
  onBack?: () => void
  onSessionsChanged?: () => void
  onTerminalReady?: (terminal: TerminalInfo) => void
  /** The attached terminal's process exited while this view watched it. */
  onTerminalClosed?: (terminalId: string, exitCode: number | null) => void
  /** The user killed this view's terminal from its header. */
  onTerminalKilled?: (terminalId: string) => void
}

export default function TerminalView({ initialCwd, initialNodeId, initialTerminalId, createMode = 'reuse', onBack, onSessionsChanged, onTerminalReady, onTerminalClosed, onTerminalKilled }: TerminalViewProps) {
  const tabHeader = useWorkbenchTabHeader()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const fitAndNotifyResizeRef = useRef<(() => void) | null>(null)
  const onSessionsChangedRef = useRef(onSessionsChanged)
  const onTerminalReadyRef = useRef(onTerminalReady)
  const onTerminalClosedRef = useRef(onTerminalClosed)
  const suppressInputForwardRef = useRef(false)

  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const statusRef = useRef<TerminalStatus>(status)
  statusRef.current = status
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  // Reconnect shows the Disconnected label while it runs; starting a new terminal does not.
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [terminalInfo, setTerminalInfo] = useState<TerminalInfo | null>(null)
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null)
  const [keyboardResetVersion, setKeyboardResetVersion] = useState(0)
  const [keyboardMode, setKeyboardMode] = useState<TerminalKeyboardMode>(() => {
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches
    try { return loadTerminalKeyboardMode(localStorage, coarsePointer) } catch { return coarsePointer ? 'web' : 'collapsed' }
  })

  const changeKeyboardMode = (nextMode: TerminalKeyboardMode) => {
    setKeyboardMode(nextMode)
    try { localStorage.setItem(TERMINAL_KEYBOARD_STORAGE_KEY, nextMode) } catch {}
  }

  const requestedTarget = useMemo(() => normalizeTerminalTarget({ nodeId: initialNodeId, cwd: initialCwd }), [initialCwd, initialNodeId])
  const requestedTargetRef = useRef(requestedTarget)
  const initialTerminalIdRef = useRef<string | undefined>(initialTerminalId)
  const createModeRef = useRef<'new' | 'reuse'>(createMode)

  useEffect(() => {
    onSessionsChangedRef.current = onSessionsChanged
  }, [onSessionsChanged])

  useEffect(() => {
    onTerminalReadyRef.current = onTerminalReady
  }, [onTerminalReady])

  useEffect(() => {
    onTerminalClosedRef.current = onTerminalClosed
  }, [onTerminalClosed])

  useEffect(() => {
    let disposed = false
    let disposePinchZoom: (() => void) | null = null
    const scheduledFitHandles: number[] = []
    let terminalStorage: Storage | null = null
    try { terminalStorage = window.localStorage } catch {}
    const initialFontSize = terminalStorage ? loadTerminalFontSize(terminalStorage) : TERMINAL_DEFAULT_FONT_SIZE
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      convertEol: false,
      scrollback: 5000,
      theme: terminalThemeFromSnapshot(getThemeSnapshot()),
    })
    const syncTheme = () => { term.options.theme = terminalThemeFromSnapshot(getThemeSnapshot()) }
    window.addEventListener(THEME_CHANGED_EVENT, syncTheme)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    const fitAndNotifyResize = () => {
      try {
        fitAddon.fit()
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }))
        }
      } catch {
        // ignore fit errors during hidden/unmounted states
      }
    }

    fitAndNotifyResizeRef.current = fitAndNotifyResize

    const setFontSize = (fontSize: number, persist: boolean) => {
      const nextFontSize = clampTerminalFontSize(fontSize)
      const currentFontSize = clampTerminalFontSize(term.options.fontSize ?? TERMINAL_DEFAULT_FONT_SIZE)
      if (nextFontSize === currentFontSize) return false
      term.options.fontSize = nextFontSize
      if (persist && terminalStorage) persistTerminalFontSize(terminalStorage, nextFontSize)
      return true
    }

    const applyFontSize = (fontSize: number, persist: boolean) => {
      if (!setFontSize(fontSize, persist)) return false
      fitAndNotifyResize()
      return true
    }

    const apple = isApplePlatform()
    term.attachCustomKeyEventHandler((event) => {
      const delta = terminalFontSizeShortcutDelta(event)
      if (delta !== null) {
        event.preventDefault()
        applyFontSize((term.options.fontSize ?? TERMINAL_DEFAULT_FONT_SIZE) + delta, true)
        return false
      }
      const action = terminalShortcutAction(event, { apple, hasSelection: term.hasSelection() })
      if (action === null) return true
      // The browser's own paste then reaches xterm's paste listener, without a clipboard permission.
      if (action === 'native-paste') return false
      event.preventDefault()
      if (action === 'copy') {
        copyTerminalText(term.getSelection())
        term.clearSelection()
      } else if (action === 'word-erase') {
        term.input('\x17', true)
      } else {
        applyFontSize(TERMINAL_DEFAULT_FONT_SIZE, true)
      }
      return false
    })

    const scheduleFit = () => {
      fitAndNotifyResize()
      scheduledFitHandles.push(window.setTimeout(fitAndNotifyResize, 50))
      scheduledFitHandles.push(window.setTimeout(fitAndNotifyResize, 250))
      window.requestAnimationFrame(() => {
        if (!disposed) {
          fitAndNotifyResize()
        }
      })
    }

    let disposeUnloadGuard: (() => void) | null = null
    if (hostRef.current) {
      term.open(hostRef.current)
      setTerminalInstance(term)
      if (term.textarea) disposeUnloadGuard = attachTerminalUnloadGuard(term.textarea, () => statusRef.current === 'ready')
      disposePinchZoom = attachTerminalPinchZoom({
        target: hostRef.current,
        getFontSize: () => term.options.fontSize ?? TERMINAL_DEFAULT_FONT_SIZE,
        setFontSize: (fontSize) => setFontSize(fontSize, true),
        refit: fitAndNotifyResize,
      })
      scheduleFit()
    }

    resizeObserverRef.current = new ResizeObserver(() => {
      fitAndNotifyResize()
    })

    if (hostRef.current) {
      resizeObserverRef.current.observe(hostRef.current)
    }

    const fontsReady = (document as any).fonts?.ready
    if (fontsReady && typeof fontsReady.then === 'function') {
      fontsReady.then(() => {
        if (!disposed) {
          fitAndNotifyResize()
        }
      }).catch(() => {})
    }

    window.addEventListener('resize', fitAndNotifyResize)

    return () => {
      disposed = true
      scheduledFitHandles.forEach((handle) => window.clearTimeout(handle))
      disposePinchZoom?.()
      disposePinchZoom = null
      disposeUnloadGuard?.()
      fitAndNotifyResizeRef.current = null
      window.removeEventListener('resize', fitAndNotifyResize)
      window.removeEventListener(THEME_CHANGED_EVENT, syncTheme)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      setTerminalInstance(null)
    }
  }, [])

  useEffect(() => {
    const term = xtermRef.current
    if (!term) return

    let disposed = false
    let exited = false
    let inputDisposable: { dispose: () => void } | null = null
    let binaryDisposable: { dispose: () => void } | null = null

    setStatus('connecting')
    setKeyboardResetVersion(version => version + 1)
    setError(null)

    const start = async () => {
      try {
        const cols = term.cols || 100
        const rows = term.rows || 30

        let terminalId = terminalIdRef.current || initialTerminalIdRef.current || null

        if (terminalId) {
          const lookupRes = await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(terminalId)}`)
          const lookupData = await lookupRes.json().catch(() => ({}))
          if (disposed) return
          if (lookupRes.status === 404) {
            // A view shows a terminal; it never replaces one that ended without being asked.
            exited = true
            setStatus('closed')
            term.writeln('[terminal is no longer running]')
            onSessionsChangedRef.current?.()
            return
          }
          if (!lookupRes.ok || !lookupData.terminal) {
            throw new Error(lookupData.error || 'Failed to look up terminal')
          }
        }

        if (!terminalId && createModeRef.current !== 'new') {
          const listRes = await fetch(`${API_BASE_PATH}/terminals`)
          const listData = await listRes.json().catch(() => ({}))
          if (!listRes.ok) {
            throw new Error(listData.error || 'Failed to list terminals')
          }

          const terminals: TerminalInfo[] = Array.isArray(listData.terminals) ? listData.terminals : []
          const reused = findTerminalForTarget(terminals, requestedTargetRef.current)

          if (reused) {
            terminalId = reused.id
          }
        }

        // A hidden/closed pane must not create a replacement PTY after its lookup settles.
        if (disposed) return

        if (!terminalId) {
          const createRes = await fetch(`${API_BASE_PATH}/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildTerminalCreateRequest(requestedTargetRef.current, cols, rows)),
          })
          const createData = await createRes.json().catch(() => ({}))
          if (!createRes.ok) {
            throw new Error(createData.error || 'Failed to create terminal')
          }
          terminalId = createData.terminal.id
        }

        if (disposed || !terminalId) {
          return
        }

        terminalIdRef.current = terminalId

        const wsUrl = makeWebSocketUrl('/terminals/stream')
        wsUrl.searchParams.set('terminalId', terminalId)
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws
        const isCurrentConnection = () => !disposed && !exited && wsRef.current === ws

        const forwardInput = (input: string) => {
          if (!isCurrentConnection() || suppressInputForwardRef.current) {
            return
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: input }))
          }
        }

        inputDisposable = term.onData((input) => {
          forwardInput(input)
        })
        binaryDisposable = term.onBinary((input) => {
          forwardInput(input)
        })

        ws.onopen = () => {
          if (!isCurrentConnection()) return
          fitAndNotifyResizeRef.current?.()
        }

        ws.onmessage = (event) => {
          if (!isCurrentConnection()) return
          try {
            const payload = JSON.parse(event.data)
            if (payload.type === 'ready') {
              term.reset()
              setKeyboardResetVersion(version => version + 1)
              setTerminalInfo(payload.terminal)
              setStatus('ready')
              setReconnecting(false)
              onTerminalReadyRef.current?.(payload.terminal)
              suppressInputForwardRef.current = true
              const finishReadyReplay = () => {
                if (!isCurrentConnection()) return
                suppressInputForwardRef.current = false
                fitAndNotifyResizeRef.current?.()
              }
              if (typeof payload.backlog === 'string' && payload.backlog.length > 0) {
                term.write(payload.backlog, finishReadyReplay)
              } else {
                finishReadyReplay()
              }
              return
            }

            if (payload.type === 'output' && typeof payload.data === 'string') {
              term.write(payload.data)
              return
            }

            if (payload.type === 'exit') {
              exited = true
              setStatus('closed')
              setTerminalInfo((current) => current ? { ...current, cwd: payload.cwd || current.cwd } : current)
              term.writeln('')
              term.writeln(`[terminal exited: code=${payload.exitCode ?? 'unknown'}]`)
              if (terminalIdRef.current) {
                onTerminalClosedRef.current?.(terminalIdRef.current, typeof payload.exitCode === 'number' ? payload.exitCode : null)
              }
              onSessionsChangedRef.current?.()
              return
            }

            if (payload.type === 'error') {
              setError(payload.message || 'Terminal stream error')
              setStatus('error')
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            setStatus('error')
          }
        }

        ws.onerror = () => {
          if (!isCurrentConnection()) return
          setStatus('error')
          setError('Terminal websocket error')
        }

        ws.onclose = () => {
          if (disposed || wsRef.current !== ws) return
          wsRef.current = null
          setKeyboardResetVersion(version => version + 1)
          if (!exited) setStatus('disconnected')
        }
      } catch (err) {
        if (disposed) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setStatus('error')
        term.writeln(`Error: ${message}`)
      }
    }

    void start()

    return () => {
      disposed = true
      suppressInputForwardRef.current = false
      inputDisposable?.dispose()
      binaryDisposable?.dispose()
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [connectionAttempt])

  const showReconnect = status === 'disconnected' || status === 'error' || (status === 'connecting' && reconnecting)

  const reconnect = () => {
    setReconnecting(true)
    setConnectionAttempt(attempt => attempt + 1)
  }

  // Starts a fresh PTY for the same Node and directory in this view.
  const startNewTerminal = () => {
    terminalIdRef.current = null
    initialTerminalIdRef.current = undefined
    createModeRef.current = 'new'
    if (terminalInfo) requestedTargetRef.current = normalizeTerminalTarget({ nodeId: terminalInfo.nodeId, cwd: terminalInfo.cwd })
    xtermRef.current?.reset()
    setTerminalInfo(null)
    setReconnecting(false)
    setConnectionAttempt(attempt => attempt + 1)
  }

  const killTerminal = async () => {
    const terminalId = terminalIdRef.current
    if (!terminalId) return
    if (!window.confirm(terminalKillConfirmation(terminalInfo ?? requestedTarget))) return
    try {
      await requestTerminalKill(terminalId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    onTerminalKilled?.(terminalId)
    onSessionsChangedRef.current?.()
  }

  const canKill = !!terminalInfo && status !== 'closed'

  return (
    <div className="flex h-full min-h-0 flex-col bg-fw-canvas">
      <WorkbenchHeaderDragArea data-terminal-header className="border-b border-fw-border bg-fw-neutral-surface px-2.5 py-1.5 dark:border-fw-border dark:bg-fw-canvas">
        <div data-workbench-pane-drag-blank className="flex items-start justify-between gap-3">
          <div data-workbench-pane-drag-blank className="min-w-0 flex-1">
            <div data-workbench-pane-drag-blank className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fw-text">
              {tabHeader ? (
                <span className="inline-flex shrink-0 items-center gap-2">
                  <WorkbenchTabClose className="inline-flex items-center justify-center rounded text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong" iconClassName="h-3.5 w-3.5" />
                  <WorkbenchTabIcon className="inline-flex items-center justify-center text-fw-text-muted"><SquareTerminal className="h-3.5 w-3.5" /></WorkbenchTabIcon>
                </span>
              ) : onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-strong md:hidden"
                  aria-label="Back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              {!showReconnect && <span>status {status}</span>}
              {keyboardMode !== 'web' && (
                <TerminalKeyboardHeaderControl
                  nativeMode={keyboardMode === 'native'}
                  onActivate={() => changeKeyboardMode('web')}
                />
              )}
              {terminalInfo && (
                <>
                  <span>node {terminalInfo.nodeId}</span>
                  <span>pid {terminalInfo.pid}</span>
                </>
              )}
              {showReconnect && (
                <span className="inline-flex items-center gap-2">
                  <span className="text-fw-danger" role="status">Disconnected</span>
                  <button
                    type="button"
                    disabled={status === 'connecting'}
                    onClick={reconnect}
                    className="rounded border border-fw-border px-1.5 py-0.5 text-[11px] leading-none text-fw-text hover:bg-fw-hover disabled:opacity-50"
                  >
                    {status === 'connecting' ? 'Reconnecting…' : 'Reconnect'}
                  </button>
                </span>
              )}
              {status === 'closed' && (
                <button
                  type="button"
                  onClick={startNewTerminal}
                  data-terminal-new
                  className="rounded border border-fw-border px-1.5 py-0.5 text-[11px] leading-none text-fw-text hover:bg-fw-hover"
                >
                  New terminal
                </button>
              )}
            </div>
            {error && (
              <div className="mt-2 rounded-md border border-fw-danger-border bg-fw-danger-surface px-2.5 py-1.5 text-xs text-fw-danger dark:border-fw-danger-border/60 dark:bg-fw-danger-surface-strong/20 dark:text-fw-danger">
                {error}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canKill && (
              <button
                type="button"
                onClick={() => { void killTerminal() }}
                title="Kill terminal"
                aria-label="Kill terminal"
                data-terminal-kill
                className="foxwarm-terminal-kill inline-flex h-5 w-5 items-center justify-center rounded text-fw-text-muted hover:bg-fw-hover hover:text-fw-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            <WorkbenchPaneControls />
          </div>
        </div>
      </WorkbenchHeaderDragArea>

      <div className="min-h-0 flex-1 overflow-hidden bg-fw-terminal-background">
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <TerminalVirtualKeyboard
        terminal={terminalInstance}
        resetToken={`${terminalIdRef.current ?? 'pending'}:${keyboardResetVersion}`}
        mode={keyboardMode}
        onModeChange={changeKeyboardMode}
      />
    </div>
  )
}
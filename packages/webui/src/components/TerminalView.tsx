import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FolderOpen } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { API_BASE_PATH, makeWebSocketUrl } from '../config'

type TerminalStatus = 'connecting' | 'ready' | 'closed' | 'error'

type TerminalInfo = {
  id: string
  sessionId: string
  agentName: string
  nodeId: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  pid: number
}

interface TerminalViewProps {
  sessionId: string
  initialCwd?: string
  initialTerminalId?: string
  createMode?: 'new' | 'reuse'
  onBack?: () => void
  onSessionsChanged?: () => void
  onTerminalReady?: (terminal: TerminalInfo) => void
  onTerminalClosed?: (terminalId: string) => void
  onOpenWorkspace?: (cwd?: string) => void
}

export default function TerminalView({ sessionId, initialCwd, initialTerminalId, createMode = 'reuse', onBack, onSessionsChanged, onTerminalReady, onTerminalClosed, onOpenWorkspace }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const onSessionsChangedRef = useRef(onSessionsChanged)
  const onTerminalReadyRef = useRef(onTerminalReady)
  const onTerminalClosedRef = useRef(onTerminalClosed)
  const suppressCloseCallbackRef = useRef(false)

  const [status, setStatus] = useState<TerminalStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [terminalInfo, setTerminalInfo] = useState<TerminalInfo | null>(null)

  const requestedCwd = useMemo(() => {
    if (typeof initialCwd === 'string' && initialCwd.trim().length > 0) {
      return initialCwd.trim()
    }
    return undefined
  }, [initialCwd])
  const requestedCwdRef = useRef<string | undefined>(requestedCwd)
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
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: '#111827',
        foreground: '#e5e7eb',
      },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    if (hostRef.current) {
      term.open(hostRef.current)
      fitAddon.fit()
    }

    resizeObserverRef.current = new ResizeObserver(() => {
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
    })

    if (hostRef.current) {
      resizeObserverRef.current.observe(hostRef.current)
    }

    return () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      wsRef.current?.close()
      wsRef.current = null
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const term = xtermRef.current
    if (!term) return

    let disposed = false
    let inputDisposable: { dispose: () => void } | null = null

    setStatus('connecting')
    setError(null)
    setTerminalInfo(null)
    terminalIdRef.current = null
    term.reset()

    const start = async () => {
      try {
        const cols = term.cols || 100
        const rows = term.rows || 30

        let terminalId = initialTerminalIdRef.current || null

        if (terminalId) {
          const lookupRes = await fetch(`${API_BASE_PATH}/terminals/${encodeURIComponent(terminalId)}`)
          const lookupData = await lookupRes.json().catch(() => ({}))
          if (lookupRes.ok && lookupData.terminal) {
            // keep existing terminal
          } else {
            terminalId = null
          }
        }

        if (!terminalId && createModeRef.current !== 'new') {
          const listRes = await fetch(`${API_BASE_PATH}/terminals?sessionId=${encodeURIComponent(sessionId)}`)
          const listData = await listRes.json().catch(() => ({}))
          if (!listRes.ok) {
            throw new Error(listData.error || 'Failed to list terminals')
          }

          const terminals: TerminalInfo[] = Array.isArray(listData.terminals) ? listData.terminals : []
          const reused = requestedCwdRef.current
            ? terminals.find((item) => item.cwd === requestedCwdRef.current)
            : terminals[0]

          if (reused) {
            terminalId = reused.id
          }
        }

        if (!terminalId) {
          const createRes = await fetch(`${API_BASE_PATH}/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              nodeId: 'master',
              cwd: requestedCwdRef.current,
              cols,
              rows,
            }),
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

        inputDisposable = term.onData((input) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: input }))
          }
        })

        ws.onopen = () => {
          try {
            fitAddonRef.current?.fit()
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          } catch {
            // ignore
          }
        }

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data)
            if (payload.type === 'ready') {
              term.reset()
              if (typeof payload.backlog === 'string' && payload.backlog.length > 0) {
                term.write(payload.backlog)
              }
              suppressCloseCallbackRef.current = false
              setTerminalInfo(payload.terminal)
              setStatus('ready')
              onTerminalReadyRef.current?.(payload.terminal)
              return
            }

            if (payload.type === 'output' && typeof payload.data === 'string') {
              term.write(payload.data)
              return
            }

            if (payload.type === 'exit') {
              setStatus('closed')
              setTerminalInfo((current) => current ? { ...current, cwd: payload.cwd || current.cwd } : current)
              term.writeln('')
              term.writeln(`[terminal exited: code=${payload.exitCode ?? 'unknown'}]`)
              if (terminalIdRef.current && !suppressCloseCallbackRef.current) {
                onTerminalClosedRef.current?.(terminalIdRef.current)
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
          setStatus('error')
          setError('Terminal websocket error')
        }

        ws.onclose = () => {
          wsRef.current = null
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setStatus('error')
        term.writeln(`Error: ${message}`)
      }
    }

    void start()

    return () => {
      disposed = true
      inputDisposable?.dispose()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-100 dark:bg-gray-900">
      <div className="border-b border-gray-200 bg-gray-100 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12px] text-gray-600 dark:text-gray-300">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 md:hidden"
                  aria-label="Back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              <span className="truncate font-mono">cwd {terminalInfo?.cwd || requestedCwd || '—'}</span>
              <span>status {status}</span>
              {terminalInfo && (
                <>
                  <span className="hidden sm:inline">shell {terminalInfo.shell}</span>
                  <span className="hidden md:inline">pid {terminalInfo.pid}</span>
                  <span className="hidden md:inline">node {terminalInfo.nodeId}</span>
                </>
              )}
            </div>
            {error && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => onOpenWorkspace?.(terminalInfo?.cwd || requestedCwd)}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Open workspace"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Workspace</span>
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[#111827]">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  )
}
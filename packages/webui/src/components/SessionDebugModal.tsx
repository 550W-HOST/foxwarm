import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import type { Message } from './chatShared'
import { copyTextToClipboard } from './chatShared'

type SessionFilePayload = {
  history?: Message[]
  persistentMemorySnapshot?: string
  [key: string]: any
}

export type SessionDebugSource = {
  sessionId: string
  sessionDisplayName?: string
  sessionRecord: object | null
  messages: Message[]
  connectionState: 'connected' | 'connecting' | 'disconnected' | 'reconnecting'
  reconnectCountdown: number
  sessionMissing: boolean
  sessionBusy: boolean
  sessionQueueLength: number
  queuedPreviewCount: number
  groupTools: boolean
  showUsageBadge: boolean
  sendKeyMode: 'modEnter' | 'enter'
  loading: boolean
  asrAvailable: boolean
  modelBusy: boolean
  streamingAssistantDraft: object | null
}

type SessionDebugModalProps = {
  source: SessionDebugSource
  onClose: () => void
}

async function fetchSessionFilePayload(sessionId: string, signal: AbortSignal): Promise<{ resolvedPath: string | null; payload: SessionFilePayload | null }> {
  const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/debug-file`, { signal })
  if (!response.ok) {
    return { resolvedPath: null, payload: null }
  }

  const data = await response.json()
  return {
    resolvedPath: typeof data?.resolvedPath === 'string' ? data.resolvedPath : null,
    payload: data?.payload && typeof data.payload === 'object' ? data.payload as SessionFilePayload : null,
  }
}

function buildSessionDebugSnapshotText(
  source: SessionDebugSource,
  fileData: { resolvedPath: string | null; payload: SessionFilePayload | null },
): string {
  return JSON.stringify({
    sessionId: source.sessionId,
    sessionDisplayName: source.sessionDisplayName || null,
    sessionRecord: source.sessionRecord,
    resolvedSessionFilePath: fileData.resolvedPath,
    sessionPayload: fileData.payload
      ? {
          ...fileData.payload,
          history: source.messages,
        }
      : {
          history: source.messages,
        },
    clientState: {
      connectionState: source.connectionState,
      reconnectCountdown: source.reconnectCountdown,
      sessionMissing: source.sessionMissing,
      sessionBusy: source.sessionBusy,
      sessionQueueLength: source.sessionQueueLength,
      queuedPreviewCount: source.queuedPreviewCount,
      groupTools: source.groupTools,
      showUsageBadge: source.showUsageBadge,
      sendKeyBehavior: source.sendKeyMode === 'enter' ? 'Enter sends; Shift+Enter inserts a new line.' : 'Ctrl/Cmd+Enter sends; Enter inserts a new line.',
      loading: source.loading,
      asrAvailable: source.asrAvailable,
      modelBusy: source.modelBusy,
      streamingAssistantDraft: source.streamingAssistantDraft,
    },
  }, null, 2)
}

export default function SessionDebugModal({ source, onClose }: SessionDebugModalProps) {
  const [snapshotText, setSnapshotText] = useState('')
  const [resolvedSessionFilePath, setResolvedSessionFilePath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const latestSourceRef = useRef(source)
  const ownerSessionIdRef = useRef(source.sessionId)
  const snapshotTextRef = useRef('')
  const requestRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  })
  const copyResetTimeoutRef = useRef<number | null>(null)
  const sessionChanged = ownerSessionIdRef.current !== source.sessionId
  if (!sessionChanged) {
    latestSourceRef.current = source
  }

  const invalidateRequest = useCallback(() => {
    requestRef.current.generation += 1
    requestRef.current.controller?.abort()
    requestRef.current.controller = null
  }, [])

  const captureSnapshot = useCallback(async () => {
    invalidateRequest()
    const controller = new AbortController()
    const generation = requestRef.current.generation
    const sourceAtCapture = latestSourceRef.current
    requestRef.current.controller = controller
    setLoading(true)
    setError(null)
    setCopied(false)

    try {
      const fileData = await fetchSessionFilePayload(sourceAtCapture.sessionId, controller.signal)
      if (controller.signal.aborted || requestRef.current.generation !== generation) return

      const text = buildSessionDebugSnapshotText(sourceAtCapture, fileData)
      snapshotTextRef.current = text
      setSnapshotText(text)
      setResolvedSessionFilePath(fileData.resolvedPath)
      if (!fileData.payload) {
        setError('Session file JSON is not available from the current WebUI runtime paths.')
      }
    } catch (captureError) {
      if (controller.signal.aborted || requestRef.current.generation !== generation) return
      console.error('Failed to refresh session debug data:', captureError)
      setError(captureError instanceof Error ? captureError.message : 'Failed to refresh debug info')
    } finally {
      if (requestRef.current.generation === generation) {
        requestRef.current.controller = null
        setLoading(false)
      }
    }
  }, [invalidateRequest])

  const handleCopy = useCallback(async () => {
    const text = snapshotTextRef.current
    if (!text) return

    try {
      await copyTextToClipboard(text)
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (copyError) {
      console.error('Failed to copy debug info:', copyError)
    }
  }, [])

  const handleClose = useCallback(() => {
    invalidateRequest()
    snapshotTextRef.current = ''
    setSnapshotText('')
    setResolvedSessionFilePath(null)
    setLoading(false)
    setError(null)
    setCopied(false)
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = null
    }
    onClose()
  }, [invalidateRequest, onClose])

  useEffect(() => {
    void captureSnapshot()
    return () => {
      invalidateRequest()
      snapshotTextRef.current = ''
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
        copyResetTimeoutRef.current = null
      }
    }
  }, [captureSnapshot, invalidateRequest])

  useEffect(() => {
    if (!sessionChanged) return
    handleClose()
  }, [handleClose, sessionChanged])

  if (sessionChanged) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-fw-overlay/50 p-4" onClick={handleClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-2xl dark:border-fw-border dark:bg-fw-canvas"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-fw-border px-4 py-3 dark:border-fw-border">
          <div>
            <div className="text-sm font-semibold text-fw-text-strong">debug info</div>
            <div className="text-xs text-fw-text-muted">Explicit session internal/debug JSON snapshot</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={captureSnapshot}
              className="rounded border border-fw-border px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover dark:border-fw-border dark:text-fw-text dark:hover:bg-fw-hover"
            >
              refresh
            </button>
            <button
              onClick={handleCopy}
              disabled={!snapshotText || loading}
              className="inline-flex items-center gap-1 rounded border border-fw-border px-3 py-1.5 text-xs text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-50 dark:border-fw-border dark:text-fw-text dark:hover:bg-fw-hover"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'copied' : 'copy'}
            </button>
            <button
              onClick={handleClose}
              className="rounded p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-strong"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-fw-surface-sunken dark:bg-fw-canvas-edge">
          <div className="border-b border-fw-border px-4 py-2 text-xs text-fw-text-muted dark:border-fw-border-muted dark:text-fw-text-muted">
            {resolvedSessionFilePath
              ? `session file: ${resolvedSessionFilePath}`
              : 'session file: unavailable from current WebUI runtime paths'}
          </div>
          {error && (
            <div className="border-b border-fw-danger-border bg-fw-danger-surface px-4 py-2 text-xs text-fw-danger dark:border-fw-danger-border/50 dark:bg-fw-danger-surface-strong/40 dark:text-fw-danger">
              {error}
            </div>
          )}
          {loading && (
            <div className="border-b border-fw-accent-border bg-fw-accent-surface px-4 py-2 text-xs text-fw-accent dark:border-fw-accent-border/50 dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent">
              Refreshing debug info...
            </div>
          )}
          <pre data-debug-info-json="true" className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-fw-text-strong">{snapshotText}</pre>
        </div>
      </div>
    </div>
  )
}

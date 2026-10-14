import type { TimelineView } from '../chatPreferences'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import type { Message } from './chatShared'
import JsonInspectorDialog from './JsonInspectorDialog'

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
  timelineView: TimelineView
  showUsageBadge: boolean
  showUserMessageMetadata: boolean
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
      timelineView: source.timelineView,
      showUsageBadge: source.showUsageBadge,
      showUserMessageMetadata: source.showUserMessageMetadata,
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  const latestSourceRef = useRef(source)
  const ownerSessionIdRef = useRef(source.sessionId)
  const requestRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  })
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

    try {
      const fileData = await fetchSessionFilePayload(sourceAtCapture.sessionId, controller.signal)
      if (controller.signal.aborted || requestRef.current.generation !== generation) return

      const text = buildSessionDebugSnapshotText(sourceAtCapture, fileData)
      setSnapshotText(text)
      setSnapshotVersion(version => version + 1)
      if (!fileData.payload) {
        setError('Some debug information is unavailable.')
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

  const handleClose = useCallback(() => {
    invalidateRequest()
    setSnapshotText('')
    setLoading(false)
    setError(null)
    onClose()
  }, [invalidateRequest, onClose])

  useEffect(() => {
    void captureSnapshot()
    return invalidateRequest
  }, [captureSnapshot, invalidateRequest])

  useEffect(() => {
    if (!sessionChanged) return
    handleClose()
  }, [handleClose, sessionChanged])

  if (sessionChanged) return null

  return (
    <JsonInspectorDialog
      title="Debug info"
      text={snapshotText}
      snapshotVersion={snapshotVersion}
      loading={loading}
      onRefresh={captureSnapshot}
      onClose={handleClose}
      status={error && <div role="alert" className="shrink-0 border-b border-fw-danger-border bg-fw-danger-surface px-4 py-2 text-xs text-fw-danger">{error}</div>}
    />
  )
}

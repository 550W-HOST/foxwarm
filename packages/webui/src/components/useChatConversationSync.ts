import { CHAT_BOOTSTRAP_TAIL_LENGTH, peekPreparedChatHistory, peekPreparedChatArchive, discardPreparedChatHistory } from '../preparedChatHistory'
import { createLocalSessionNotice } from '../sessionNotices'
import { getSessionControlAction, parseSessionControlFeedback, type SessionControlAction, type SessionControlFeedback } from '../../../shared/src/sessionControlFeedback'
import { appendContinuousCommits, mergeContinuousHistory, type HistoryMode } from '../continuousHistory'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import type { Message, MessagePart, SessionStreamEvent, ToolScriptSubCall } from './chatShared'
import type { ChildPolicyChainEntry } from './childModelState'
import { applyModelStreamEvent, applyModelStreamSnapshot, reconcileCommittedModelDraft, shouldClearDraftAfterHistory, type StreamingAssistantDraft } from '../streamingAssistantDraft'
import { isSessionRuntimeActive, type SessionRuntimeState } from '../sessionRuntimeState'
import { shouldAppendOptimisticMessage } from '../utils/chatOptimistic'
import { buildReferencedAttachmentParts } from '../attachmentRefs'
import { postReferencedMessage, toLegacyUploadedFiles, uploadReferencedFiles } from '../attachmentSend'
import { createLatestRequestGate } from '../modelOptionsLoader'
import { webUiRealtime } from '../realtime'
import {
  advanceHistorySeqFrontier,
  buildOptimisticUserMessage,
  countCommittedHistoryMessages,
  decideHistoryReconciliation,
  getClientMessageId,
  getLatestCommittedMessageSeq,
  hasStableHistoryIdentity,
  mergeHistoryMessages,
  mergeHistorySnapshot,
  reconcileHistoryMessage,
} from '../chatHistoryState'

const HISTORY_BOOTSTRAP_TAIL_LENGTH = CHAT_BOOTSTRAP_TAIL_LENGTH
type ArchivePageDirection = 'initial' | 'earlier' | 'later' | 'latest'

type ChatSessionRecord = {
  id: string
  agent?: string
  messageCount?: number
  historyVersion?: number
  lastMessageTime?: number
  parentSessionId?: string | null
  childSessions?: string[]
  aliases?: string[]
  busy?: boolean
  busyStartedAt?: number | null
  queueLength?: number
  runtimeState?: SessionRuntimeState
  displayName?: string | null
  archived?: boolean
  currentNode?: string
  cwd?: string | null
  model?: string | null
  modelKey?: string
  defaultModelKey?: string
  childModelDefault?: string | null
  childModelPolicySource?: 'explicit' | 'follow-parent'
  childPolicyChain?: ChildPolicyChainEntry[]
  effectiveChildModelKey?: string
  effort?: string | null
  effectiveEffort?: string
  effortAllowed?: string[]
  effortDefault?: string | null
  childEffortDefault?: string | null
  effectiveChildEffort?: string
  childEffortAllowed?: string[]
  childModelEffortDefault?: string | null
  isolated?: boolean
}

export type HistoryResponse = {
  session?: ChatSessionRecord
  messages?: Message[]
  persistentMemorySnapshot?: string
  queuedMessages?: Message[]
  queueLength?: number
  latestSeq?: number
  historyVersion?: number
  prefixLength?: number
  historyComplete?: boolean
  code?: string
  error?: string
}

type HistoryFetchMode = 'bootstrap' | 'full' | 'after' | 'reconcile'
type PendingQueueAppend = { historyVersion: number; startSeq: number; endSeq: number }

type TimelineState = { messages: Message[]; queuedMessages: Message[]; archiveMessages: Message[]; archivePendingMessages: Message[]; archiveStatus: 'idle' | 'loading' | 'loaded' }
type TimelineAction =
  | { type: 'archive-start'; replace?: boolean }
  | { type: 'archive'; messages: Message[]; reset?: boolean; replace?: boolean }
  | { type: 'messages'; update: Message[] | ((messages: Message[]) => Message[]); archiveMessages?: Message[] }
  | { type: 'queue'; update: Message[] | ((messages: Message[]) => Message[]) }
  | { type: 'atomic'; messages: Message[] | ((messages: Message[]) => Message[]); queuedMessages: Message[]; archiveMessages?: Message[] }

function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  if (action.type === 'archive-start') {
    return { ...state, archiveStatus: 'loading', archivePendingMessages: action.replace ? [] : state.archivePendingMessages }
  }
  if (action.type === 'archive') {
    const originals = mergeContinuousHistory(action.replace ? [] : state.archiveMessages, action.messages)
    return {
      ...state,
      archiveStatus: action.reset ? 'idle' : 'loaded',
      archiveMessages: action.reset ? [] : appendContinuousCommits(originals, state.archivePendingMessages),
      archivePendingMessages: [],
    }
  }
  if (action.type === 'queue') {
    return { ...state, queuedMessages: typeof action.update === 'function' ? action.update(state.queuedMessages) : action.update }
  }
  const update = action.type === 'atomic' ? action.messages : action.update
  const messages = typeof update === 'function' ? update(state.messages) : update
  return {
    ...state,
    messages,
    archiveMessages: action.archiveMessages && state.archiveStatus !== 'idle'
      ? appendContinuousCommits(state.archiveMessages, action.archiveMessages) : state.archiveMessages,
    archivePendingMessages: action.archiveMessages && state.archiveStatus === 'loading'
      ? mergeContinuousHistory(state.archivePendingMessages, action.archiveMessages) : state.archivePendingMessages,
    ...(action.type === 'atomic' ? { queuedMessages: action.queuedMessages } : {}),
  }
}

type ConfirmedSessionSettings = Partial<Pick<ChatSessionRecord,
  | 'currentNode' | 'cwd'
  | 'model' | 'modelKey' | 'defaultModelKey'
  | 'childModelDefault' | 'childModelPolicySource' | 'childPolicyChain' | 'effectiveChildModelKey'
  | 'effort' | 'effectiveEffort' | 'effortAllowed' | 'effortDefault'
  | 'childEffortDefault' | 'effectiveChildEffort' | 'childEffortAllowed' | 'childModelEffortDefault'
>>

/** One mounted Chat's history, queue, draft and send lifetime; viewport and physical transport stay separate. */
export function useChatConversationSync(sessionId: string, webUiIdentityMode: boolean, historyMode: HistoryMode = 'active', initialArchiveSeq?: number) {
  const prepared = useMemo(() => peekPreparedChatHistory(sessionId), [sessionId])
  const preparedArchive = useMemo(() => {
    const archive = historyMode === 'continuous' ? peekPreparedChatArchive(sessionId) : undefined
    return archive?.anchorSeq === initialArchiveSeq ? archive : undefined
  }, [sessionId,historyMode,initialArchiveSeq])
  const preparedResponseRef = useRef(prepared)
  const [timelineState, dispatchTimeline] = useReducer(timelineReducer, { messages: prepared?.messages || [], queuedMessages: prepared?.queuedMessages || [], archiveMessages: preparedArchive ? mergeContinuousHistory([],preparedArchive.messages) : [], archivePendingMessages: [], archiveStatus: preparedArchive ? 'loaded' : 'idle' })
  const messages = timelineState.messages
  const queuedMessages = timelineState.queuedMessages
  const [archivePage, setArchivePage] = useState({ loaded: !!preparedArchive, loading: false, error: false, hasEarlier: !!preparedArchive?.hasEarlier, hasLater: !!preparedArchive?.hasLater, direction: 'initial' as ArchivePageDirection })
  const archiveRequestRef = useRef<AbortController | null>(null)
  const archiveBoundaryRef = useRef<{ firstSeq?: number; lastSeq?: number }>({firstSeq:preparedArchive?.firstSeq,lastSeq:preparedArchive?.lastSeq})
  const [historySnapshotRevision, setHistorySnapshotRevision] = useState(0)
  const archiveSnapshotRevisionRef = useRef(preparedArchive ? 0 : -1)
  const loadArchivePage = useCallback(async (direction: ArchivePageDirection = 'initial', beforePublish?: (rows: Message[]) => void): Promise<Message[]> => {
    if (archiveRequestRef.current) {
      if (direction !== 'latest') return []
      archiveRequestRef.current.abort()
    }
    const controller = new AbortController()
    archiveRequestRef.current = controller
    const restoringAnchor = direction === 'initial' && initialArchiveSeq !== undefined
    setArchivePage(previous => ({ ...previous, loading: true, error: false, direction, ...(restoringAnchor ? { hasLater: true } : {}) }))
    const boundary = archiveBoundaryRef.current
    const replace = direction === 'initial' || direction === 'latest'
    dispatchTimeline({ type: 'archive-start', replace })
    const seq = direction === 'earlier' ? boundary.firstSeq : direction === 'later' ? boundary.lastSeq : undefined
    const query = seq ? `?${direction === 'earlier' ? 'beforeSeq' : 'afterSeq'}=${seq}` : ''
    const fetchPage = async (pageQuery: string) => {
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history/continuous${pageQuery}`, { signal: controller.signal })
      if (!response.ok) throw new Error('History could not be loaded')
      return response.json()
    }
    try {
      // Two bounded pages surround the saved row, leaving room to restore its pixel offset.
      // No previously loaded pages or whole-Archive scan are needed after a remount.
      let data
      if (restoringAnchor) {
        const [earlier, later] = await Promise.all([
          fetchPage(`?beforeSeq=${initialArchiveSeq! + 1}`),
          fetchPage(`?afterSeq=${initialArchiveSeq}`),
        ])
        data = { messages: [...earlier.messages, ...later.messages],
          firstSeq: earlier.firstSeq ?? later.firstSeq, lastSeq: later.lastSeq ?? earlier.lastSeq,
          hasEarlier: earlier.hasMore, hasLater: later.hasMore }
      } else data = await fetchPage(query)
      if (controller.signal.aborted) return []
      const rows = Array.isArray(data.messages) ? data.messages as Message[] : []
      beforePublish?.(rows)
      archiveBoundaryRef.current = {
        firstSeq: direction === 'later' ? boundary.firstSeq ?? data.firstSeq : data.firstSeq ?? boundary.firstSeq,
        lastSeq: direction === 'earlier' ? boundary.lastSeq ?? data.lastSeq : data.lastSeq ?? boundary.lastSeq,
      }
      dispatchTimeline({ type: 'archive', messages: rows, replace })
      setArchivePage(previous => ({ loaded: true, loading: false, error: false, direction,
        hasEarlier: restoringAnchor ? !!data.hasEarlier : direction === 'later' ? previous.hasEarlier : !!data.hasMore,
        hasLater: restoringAnchor ? !!data.hasLater : direction === 'earlier' ? previous.hasLater : direction === 'later' && !!data.hasMore }))
      return rows
    } catch (error) {
      if (!controller.signal.aborted) {
        setArchivePage(previous => ({ ...previous, loading: false, error: true }))
        controller.abort()
      }
      return []
    } finally {
      if (archiveRequestRef.current === controller) archiveRequestRef.current = null
    }
  }, [initialArchiveSeq, sessionId])
  const setMessages = useCallback((update: Message[] | ((messages: Message[]) => Message[]), archiveMessages?: Message[]) => dispatchTimeline({ type: 'messages', update, archiveMessages }), [])
  const setQueuedMessages = useCallback((update: Message[] | ((messages: Message[]) => Message[])) => dispatchTimeline({ type: 'queue', update }), [])
  const [sessionMissing, setSessionMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pendingControl, setPendingControl] = useState<SessionControlAction | null>(null)
  const [controlFeedback, setControlFeedback] = useState<SessionControlFeedback | null>(null)
  const pendingControlRef = useRef<{ id: string; action: SessionControlAction; timer: number; accepted: boolean; queuedAtStart: number } | null>(null)
  const lastControlIdRef = useRef<string | null>(null)
  const clearPendingControl = useCallback(() => {
    if (pendingControlRef.current) window.clearTimeout(pendingControlRef.current.timer)
    pendingControlRef.current = null
    setPendingControl(null)
  }, [])
  useEffect(() => {
    setPendingControl(null); setControlFeedback(null); lastControlIdRef.current = null
    return () => { if (pendingControlRef.current) window.clearTimeout(pendingControlRef.current.timer); pendingControlRef.current = null }
  }, [sessionId])
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionQueueLength, setSessionQueueLength] = useState(0)
  const [connectionState, setConnectionState] = useState<'connected' | 'connecting' | 'disconnected' | 'reconnecting'>('connecting')
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0)
  const [streamingAssistantDraft, setStreamingAssistantDraft] = useState<StreamingAssistantDraft | null>(null)
  const streamingAssistantDraftRef = useRef<StreamingAssistantDraft | null>(null)
  const clearStreamingAssistantDraft = useCallback(() => {
    streamingAssistantDraftRef.current = null
    setStreamingAssistantDraft(null)
  }, [])
  const [toolScriptProgress, setToolScriptProgress] = useState<Record<string, ToolScriptSubCall[]>>({})
  const [sessionRecord, setSessionRecord] = useState<ChatSessionRecord | null>(prepared?.session || null)
  const [persistentMemorySnapshot, setPersistentMemorySnapshot] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(!!prepared)
  const [isFullHistoryLoaded, setIsFullHistoryLoaded] = useState(false)
  const [earlierHistoryError, setEarlierHistoryError] = useState(false)
  const lastKnownTimestampRef = useRef<number>(0)
  const pendingSentMessageIdsRef = useRef<Set<string>>(new Set())
  const sessionBusyRef = useRef(false)
  const sessionQueueLengthRef = useRef(0)
  const sessionMessageCountRef = useRef(0)
  const sessionHistoryVersionRef = useRef(0)
  const representedMessageCountRef = useRef(0)
  const representedHistoryVersionRef = useRef(0)
  const latestCommittedSeqRef = useRef(0)
  const hasTrustedHistoryFrontierRef = useRef(false)
  const historyBootstrapStartedRef = useRef(false)
  const fullHistoryLoadedRef = useRef(false)
  const reconnectAwaitingStateRef = useRef(false)
  const queueRefreshNeededRef = useRef(false)
  const historyGapDetectedRef = useRef(false)
  const pendingQueueAppendRef = useRef<PendingQueueAppend | null>(null)
  const atomicRecoveryScheduledRef = useRef(false)
  const queuedMessagesRef = useRef<Message[]>([])
  const sessionStateInitializedRef = useRef(false)
  const historyRequestGateRef = useRef(createLatestRequestGate())
  const historyAbortControllerRef = useRef<AbortController | null>(null)
  const historyInFlightRef = useRef<{ sessionId: string; promise: Promise<boolean>; controller: AbortController } | null>(null)
  const historyTrailingRefreshRef = useRef(false)
  const historyEventVersionRef = useRef(0)
  const historyStateEventVersionRef = useRef(0)
  const historyModelStreamEventVersionRef = useRef(0)
  const historyEventsRef = useRef<Array<{ version: number; message: Message }>>([])
  const historyRefreshTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    preparedResponseRef.current = prepared
    setMessages(prepared?.messages || [])
    dispatchTimeline({ type: 'archive', messages: preparedArchive?.messages || [], reset: !preparedArchive, replace: true })
    archiveRequestRef.current?.abort()
    archiveRequestRef.current = null
    archiveBoundaryRef.current = {firstSeq:preparedArchive?.firstSeq,lastSeq:preparedArchive?.lastSeq}
    archiveSnapshotRevisionRef.current = preparedArchive ? 0 : -1
    setArchivePage({ loaded: !!preparedArchive, loading: false, error: false, hasEarlier: !!preparedArchive?.hasEarlier, hasLater: !!preparedArchive?.hasLater, direction: 'initial' })
    setHistoryLoaded(!!prepared)
    setIsFullHistoryLoaded(prepared?.historyComplete === true)
    setEarlierHistoryError(false)
    clearStreamingAssistantDraft()
    setToolScriptProgress({})
    setQueuedMessages(prepared?.queuedMessages || [])
    setSessionRecord(prepared?.session || null)
    setSessionBusy(!!prepared?.session && isSessionRuntimeActive(prepared.session))
    setSessionQueueLength(prepared?.queueLength || 0)
    sessionBusyRef.current = !!prepared?.session && isSessionRuntimeActive(prepared.session)
    sessionQueueLengthRef.current = prepared?.queueLength || 0
    sessionMessageCountRef.current = prepared?.session?.messageCount || 0
    sessionHistoryVersionRef.current = prepared?.historyVersion || 0
    representedMessageCountRef.current = countCommittedHistoryMessages(prepared?.messages || [])
    representedHistoryVersionRef.current = prepared?.historyVersion || 0
    latestCommittedSeqRef.current = getLatestCommittedMessageSeq(prepared?.messages || [])
    hasTrustedHistoryFrontierRef.current = false
    historyBootstrapStartedRef.current = false
    fullHistoryLoadedRef.current = prepared?.historyComplete === true
    reconnectAwaitingStateRef.current = false
    queueRefreshNeededRef.current = false
    historyGapDetectedRef.current = false
    pendingQueueAppendRef.current = null
    atomicRecoveryScheduledRef.current = false
    queuedMessagesRef.current = prepared?.queuedMessages || []
    pendingSentMessageIdsRef.current.clear()
    sessionStateInitializedRef.current = !!prepared?.session
    historyRequestGateRef.current.invalidate()
    historyAbortControllerRef.current?.abort()
    historyAbortControllerRef.current = null
    historyInFlightRef.current = null
    historyTrailingRefreshRef.current = false
    historyEventVersionRef.current = 0
    historyStateEventVersionRef.current = 0
    historyModelStreamEventVersionRef.current = 0
    historyEventsRef.current = []
    setPersistentMemorySnapshot('')
  }, [clearStreamingAssistantDraft, sessionId])

  useEffect(() => {
    sessionBusyRef.current = sessionBusy
  }, [sessionBusy])

  useEffect(() => {
    sessionQueueLengthRef.current = sessionQueueLength
  }, [sessionQueueLength])

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages
  }, [queuedMessages])

  useEffect(() => {
    if (!sessionBusy) {
      clearStreamingAssistantDraft()
    }
  }, [clearStreamingAssistantDraft, sessionBusy])

  const applySessionState = useCallback((session: ChatSessionRecord | null | undefined) => {
    if (!session || typeof session.id !== 'string') return
    const nextBusy = isSessionRuntimeActive(session)
    const previousBusy = sessionBusyRef.current
    const nextQueueLength = typeof session.queueLength === 'number' ? session.queueLength : 0
    const nextMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0
    const nextHistoryVersion = typeof session.historyVersion === 'number' ? session.historyVersion : 0
    sessionBusyRef.current = nextBusy
    const pending = pendingControlRef.current
    if (pending && (pending.action === 'continue' && nextBusy
      || pending.action === 'stop' && (previousBusy && !nextBusy || !!session.runtimeState?.stopping)
      || pending.action === 'dequeue' && nextQueueLength < pending.queuedAtStart
      || pending.action === 'cancel-compaction' && !session.runtimeState?.compaction
      || pending.action === 'compact' && !!session.runtimeState?.compaction)) clearPendingControl()
    if (previousBusy !== nextBusy) setControlFeedback(previous => {
      if (!previous || previous.status === 'accepted' || previous.status === 'noop') return null
      return previous.action === 'stop' && !nextBusy || previous.action === 'continue' && nextBusy ? null : previous
    })
    sessionQueueLengthRef.current = nextQueueLength
    sessionMessageCountRef.current = nextMessageCount
    sessionHistoryVersionRef.current = nextHistoryVersion
    sessionStateInitializedRef.current = true
    setSessionRecord(session)
    setSessionBusy(nextBusy)
    setSessionQueueLength(nextQueueLength)
  }, [clearPendingControl])

  const fetchHistory = useCallback(async (requestedMode: HistoryFetchMode = 'full') => {
    let mode = requestedMode
    if (mode === 'reconcile') {
      if (!historyBootstrapStartedRef.current) return true
      const decision = decideHistoryReconciliation({
        fullHistoryLoaded: fullHistoryLoadedRef.current,
        serverMessageCount: sessionMessageCountRef.current,
        representedMessageCount: representedMessageCountRef.current,
        serverHistoryVersion: sessionHistoryVersionRef.current,
        representedHistoryVersion: representedHistoryVersionRef.current,
        hasTrustedFrontier: hasTrustedHistoryFrontierRef.current,
        queueRefreshNeeded: queueRefreshNeededRef.current,
        gapDetected: historyGapDetectedRef.current,
      })
      if (decision === 'none') {
        reconnectAwaitingStateRef.current = false
        return true
      }
      mode = decision
    }

    const activeRequest = historyInFlightRef.current
    if (activeRequest?.sessionId === sessionId) {
      historyTrailingRefreshRef.current = true
      return activeRequest.promise
    }

    const requestSequence = historyRequestGateRef.current.begin()
    const eventVersionAtStart = historyEventVersionRef.current
    const stateEventVersionAtStart = historyStateEventVersionRef.current
    const modelStreamEventVersionAtStart = historyModelStreamEventVersionRef.current
    const modelStreamDraftAtStart = streamingAssistantDraftRef.current
    const controller = new AbortController()
    historyAbortControllerRef.current = controller

    const requestJson = async (query = ''): Promise<{ response: Response; data: HistoryResponse }> => {
      if (mode === 'bootstrap' && preparedResponseRef.current && query === `?tail=${HISTORY_BOOTSTRAP_TAIL_LENGTH}`) {
        const data = preparedResponseRef.current
        preparedResponseRef.current = null
        discardPreparedChatHistory(sessionId)
        return { response: new Response(null, { status: 200 }), data }
      }
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/history${query}`, {
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({})) as HistoryResponse
      return { response, data }
    }

    const requestPromise = (async () => {
      const isCurrent = () => historyRequestGateRef.current.isCurrent(requestSequence)
      const handleMissing = (response: Response): boolean | null => {
        if (response.status !== 404) return null
        if (historyStateEventVersionRef.current > stateEventVersionAtStart) return true
        setSessionMissing(true)
        archiveRequestRef.current?.abort()
        dispatchTimeline({ type: 'archive', messages: [], reset: true })
        setMessages([])
        setQueuedMessages([])
        setSessionQueueLength(0)
        setPersistentMemorySnapshot('')
        lastKnownTimestampRef.current = 0
        representedMessageCountRef.current = 0
        latestCommittedSeqRef.current = 0
        hasTrustedHistoryFrontierRef.current = false
        pendingQueueAppendRef.current = null
        atomicRecoveryScheduledRef.current = false
        fullHistoryLoadedRef.current = true
        setIsFullHistoryLoaded(true)
        setHistoryLoaded(true)
        return false
      }
      const concurrentMessages = () => historyEventsRef.current
        .filter(entry => entry.version > eventVersionAtStart)
        .map(entry => entry.message)
      const updateFrontier = (data: HistoryResponse, snapshotMessages: Message[], complete: boolean) => {
        const version = typeof data.historyVersion === 'number'
          ? data.historyVersion
          : typeof data.session?.historyVersion === 'number' ? data.session.historyVersion : 0
        representedHistoryVersionRef.current = version
        const responseLatestSeq = typeof data.latestSeq === 'number' ? data.latestSeq : getLatestCommittedMessageSeq(snapshotMessages)
        const hasAuthoritativeFrontier = typeof data.latestSeq === 'number'
        if (hasAuthoritativeFrontier) {
          let contiguousLatestSeq = responseLatestSeq
          const concurrentSeqs = concurrentMessages()
            .map(message => message.__meta?.seq)
            .filter((seq): seq is number => Number.isSafeInteger(seq))
          for (const seq of [...new Set(concurrentSeqs)].sort((left, right) => left - right)) {
            contiguousLatestSeq = advanceHistorySeqFrontier(contiguousLatestSeq, seq).latestSeq
          }
          latestCommittedSeqRef.current = contiguousLatestSeq
        } else {
          latestCommittedSeqRef.current = Math.max(responseLatestSeq, getLatestCommittedMessageSeq(concurrentMessages()))
        }
        hasTrustedHistoryFrontierRef.current = hasAuthoritativeFrontier
        if (complete) {
          fullHistoryLoadedRef.current = true
          setIsFullHistoryLoaded(true)
          setEarlierHistoryError(false)
        }
      }
      const applyMetadata = (data: HistoryResponse, deferTimeline = false): boolean => {
        const hasNewerStreamState = historyStateEventVersionRef.current > stateEventVersionAtStart
        const historyQueueLength = typeof data.queueLength === 'number' ? data.queueLength : null
        const hasNewerMismatchedQueue = hasNewerStreamState
          && historyQueueLength !== null
          && historyQueueLength !== sessionQueueLengthRef.current
        if (!hasNewerStreamState) {
          setSessionMissing(false)
          applySessionState(data.session)
        }
        if (hasNewerMismatchedQueue) {
          queueRefreshNeededRef.current = true
          historyTrailingRefreshRef.current = true
        } else if (!deferTimeline) {
          setQueuedMessages(Array.isArray(data.queuedMessages) ? data.queuedMessages : [])
          queueRefreshNeededRef.current = false
        }
        setPersistentMemorySnapshot(typeof data.persistentMemorySnapshot === 'string' ? data.persistentMemorySnapshot : '')
        if (!hasNewerStreamState && typeof data.queueLength === 'number') setSessionQueueLength(data.queueLength)
        return hasNewerMismatchedQueue
      }
      const maybeClearDraft = (snapshotMessages: Message[]) => {
        const current = streamingAssistantDraftRef.current
        if (current) {
          const reconciled = snapshotMessages
            .filter(message => message.role === 'model' && message.__meta?.llmSegment
              && message.__meta?.llmRequestId === current.llmRequestId)
            .sort((a, b) => (a.__meta?.llmSegment?.outputEndExclusive || 0) - (b.__meta?.llmSegment?.outputEndExclusive || 0))
            .reduce<StreamingAssistantDraft | null>(reconcileCommittedModelDraft, current)
          if (reconciled !== current) {
            streamingAssistantDraftRef.current = reconciled
            setStreamingAssistantDraft(reconciled)
          }
        }
        if (shouldClearDraftAfterHistory({
          draftAtRequestStart: modelStreamDraftAtStart,
          currentDraft: streamingAssistantDraftRef.current,
          hasNewerStreamEvent: historyModelStreamEventVersionRef.current > modelStreamEventVersionAtStart,
          snapshotMessages,
        })) clearStreamingAssistantDraft()
      }
      const updateLastTimestamp = (snapshotMessages: Message[]) => {
        const lastTimestamp = snapshotMessages.reduce((latest, message) => Math.max(latest, message.__meta?.timestamp || 0), 0)
        lastKnownTimestampRef.current = Math.max(lastKnownTimestampRef.current, lastTimestamp)
      }
      const applyFullSnapshot = (data: HistoryResponse, snapshotMessages: Message[]) => {
        const concurrent = concurrentMessages()
        const pending = pendingQueueAppendRef.current
        const responseLatestSeq = typeof data.latestSeq === 'number' ? data.latestSeq : getLatestCommittedMessageSeq(snapshotMessages)
        const responseVersion = typeof data.historyVersion === 'number' ? data.historyVersion : 0
        const pendingCovered = !pending || responseVersion !== pending.historyVersion || responseLatestSeq >= pending.endSeq
        const queueMismatch = applyMetadata(data, true)
        if (!pendingCovered || queueMismatch) {
          historyTrailingRefreshRef.current = true
          return false
        }
        dispatchTimeline({
          type: 'atomic',
          messages: currentMessages => {
            const merged = mergeHistorySnapshot({ snapshot: snapshotMessages, concurrentMessages: concurrent, currentMessages, pendingClientMessageIds: pendingSentMessageIdsRef.current })
            representedMessageCountRef.current = countCommittedHistoryMessages(merged)
            return merged
          },
          queuedMessages: Array.isArray(data.queuedMessages) ? data.queuedMessages : [],
        })
        queuedMessagesRef.current = Array.isArray(data.queuedMessages) ? data.queuedMessages : []
        if (pending) {
          pendingQueueAppendRef.current = null
          atomicRecoveryScheduledRef.current = false
        }
        queueRefreshNeededRef.current = false
        for (const message of snapshotMessages) {
          const clientMessageId = getClientMessageId(message)
          if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
        }
        updateFrontier(data, snapshotMessages, true)
        updateLastTimestamp(snapshotMessages)
        return true
      }
      const applySnapshotBeforePendingQueueAppend = (data: HistoryResponse, snapshotMessages: Message[]) => {
        const pending = pendingQueueAppendRef.current
        if (!pending) return false
        const responseLatestSeq = typeof data.latestSeq === 'number' ? data.latestSeq : getLatestCommittedMessageSeq(snapshotMessages)
        const responseVersion = typeof data.historyVersion === 'number' ? data.historyVersion : 0
        if (responseVersion !== pending.historyVersion || responseLatestSeq >= pending.startSeq) return false
        const concurrent = concurrentMessages()
        setMessages(currentMessages => {
          const merged = mergeHistorySnapshot({ snapshot: snapshotMessages, concurrentMessages: concurrent, currentMessages, pendingClientMessageIds: pendingSentMessageIdsRef.current })
          representedMessageCountRef.current = countCommittedHistoryMessages(merged)
          return merged
        })
        for (const message of snapshotMessages) {
          const clientMessageId = getClientMessageId(message)
          if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
        }
        updateFrontier(data, snapshotMessages, true)
        updateLastTimestamp(snapshotMessages)
        historyGapDetectedRef.current = true
        queueRefreshNeededRef.current = true
        historyTrailingRefreshRef.current = true
        return true
      }
      const fetchAndApplyFull = async (): Promise<boolean> => {
        const { response, data } = await requestJson()
        if (!isCurrent()) return true
        const missing = handleMissing(response)
        if (missing !== null) return missing
        if (!response.ok) throw new Error(data.error || `Failed to fetch history (${response.status})`)
        const snapshotMessages = Array.isArray(data.messages) ? data.messages : []
        if (!applyFullSnapshot(data, snapshotMessages)) return true
        maybeClearDraft(snapshotMessages)
        setHistorySnapshotRevision(revision => revision + 1)
        historyGapDetectedRef.current = false
        reconnectAwaitingStateRef.current = false
        historyEventsRef.current = []
        if (historyStateEventVersionRef.current > stateEventVersionAtStart) historyTrailingRefreshRef.current = true
        setHistoryLoaded(true)
        return true
      }

      try {
        if (mode === 'bootstrap') {
          const { response, data } = await requestJson(`?tail=${HISTORY_BOOTSTRAP_TAIL_LENGTH}`)
          if (!isCurrent()) return true
          const missing = handleMissing(response)
          if (missing !== null) return missing
          if (!response.ok) throw new Error(data.error || `Failed to fetch recent history (${response.status})`)
          const tailMessages = Array.isArray(data.messages) ? data.messages : []
          applyMetadata(data)
          const concurrent = concurrentMessages()
          setMessages(currentMessages => mergeHistorySnapshot({
            snapshot: tailMessages,
            concurrentMessages: concurrent,
            currentMessages,
            pendingClientMessageIds: pendingSentMessageIdsRef.current,
          }))
          updateFrontier(data, tailMessages, false)
          updateLastTimestamp(tailMessages)
          maybeClearDraft(tailMessages)

          const prefixLength = typeof data.prefixLength === 'number' ? data.prefixLength : 0
          const historyVersion = typeof data.historyVersion === 'number'
            ? data.historyVersion
            : typeof data.session?.historyVersion === 'number' ? data.session.historyVersion : 0
          if (prefixLength > 0) {
            const prefixResult = await requestJson(`?prefixLength=${prefixLength}&historyVersion=${historyVersion}`)
            if (!isCurrent()) return true
            if (prefixResult.response.status === 409 && prefixResult.data.code === 'SESSION_HISTORY_BOUNDARY_STALE') {
              return fetchAndApplyFull()
            }
            if (!prefixResult.response.ok) {
              setEarlierHistoryError(true)
              return true
            }
            const prefixMessages = Array.isArray(prefixResult.data.messages) ? prefixResult.data.messages : []
            const assembledSnapshot = [...prefixMessages, ...tailMessages]
            if (!applyFullSnapshot(data, assembledSnapshot)
              && !applySnapshotBeforePendingQueueAppend(data, assembledSnapshot)) return true
          } else {
            setMessages(currentMessages => {
              representedMessageCountRef.current = countCommittedHistoryMessages(currentMessages)
              return currentMessages
            })
            updateFrontier(data, tailMessages, true)
          }
          historyEventsRef.current = []
          if (historyStateEventVersionRef.current > stateEventVersionAtStart) historyTrailingRefreshRef.current = true
          setHistoryLoaded(true)
          return true
        }

        if (mode === 'full') return fetchAndApplyFull()

        const historyVersion = representedHistoryVersionRef.current
        const afterSeq = latestCommittedSeqRef.current
        const { response, data } = await requestJson(`?afterSeq=${afterSeq}&historyVersion=${historyVersion}`)
        if (!isCurrent()) return true
        const missing = handleMissing(response)
        if (missing !== null) return missing
        if (response.status === 409 && data.code === 'SESSION_HISTORY_BOUNDARY_STALE') return fetchAndApplyFull()
        if (!response.ok) throw new Error(data.error || `Failed to reconcile history (${response.status})`)
        const appendedMessages = Array.isArray(data.messages) ? data.messages : []
        const pending = pendingQueueAppendRef.current
        const responseLatestSeq = typeof data.latestSeq === 'number' ? data.latestSeq : getLatestCommittedMessageSeq(appendedMessages)
        const responseVersion = typeof data.historyVersion === 'number' ? data.historyVersion : historyVersion
        const queueMismatch = applyMetadata(data, true)
        if (queueMismatch || pending && responseVersion === pending.historyVersion && responseLatestSeq < pending.endSeq) {
          historyTrailingRefreshRef.current = true
          return true
        }
        dispatchTimeline({
          type: 'atomic',
          messages: currentMessages => {
            const merged = mergeHistoryMessages(currentMessages, appendedMessages)
            representedMessageCountRef.current = countCommittedHistoryMessages(merged)
            return merged
          },
          queuedMessages: Array.isArray(data.queuedMessages) ? data.queuedMessages : [],
        })
        queuedMessagesRef.current = Array.isArray(data.queuedMessages) ? data.queuedMessages : []
        if (pending) {
          pendingQueueAppendRef.current = null
          atomicRecoveryScheduledRef.current = false
        }
        queueRefreshNeededRef.current = false
        for (const message of appendedMessages) {
          const clientMessageId = getClientMessageId(message)
          if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
        }
        updateFrontier(data, appendedMessages, true)
        updateLastTimestamp(appendedMessages)
        maybeClearDraft(appendedMessages)
        setHistorySnapshotRevision(revision => revision + 1)
        historyGapDetectedRef.current = false
        reconnectAwaitingStateRef.current = false
        historyEventsRef.current = []
        if (historyStateEventVersionRef.current > stateEventVersionAtStart) historyTrailingRefreshRef.current = true
        setHistoryLoaded(true)
        return true
      } catch (error) {
        if (controller.signal.aborted) return true
        if (pendingQueueAppendRef.current) atomicRecoveryScheduledRef.current = false
        console.error('Failed to fetch history:', error)
        if (mode === 'bootstrap') {
          setEarlierHistoryError(true)
          setHistoryLoaded(true)
        }
        return true
      } finally {
        if (historyAbortControllerRef.current === controller) historyAbortControllerRef.current = null
      }
    })()

    historyInFlightRef.current = { sessionId, promise: requestPromise, controller }
    void requestPromise.finally(() => {
      if (historyInFlightRef.current?.controller !== controller) return
      historyInFlightRef.current = null
      if (!historyTrailingRefreshRef.current || !historyRequestGateRef.current.isCurrent(requestSequence)) return
      historyTrailingRefreshRef.current = false
      historyRefreshTimeoutRef.current = window.setTimeout(() => {
        historyRefreshTimeoutRef.current = null
        void fetchHistory('reconcile')
      }, 0)
    })
    return requestPromise
  }, [applySessionState, clearStreamingAssistantDraft, sessionId])

  const scheduleAtomicRecovery = useCallback(() => {
    if (atomicRecoveryScheduledRef.current) return
    atomicRecoveryScheduledRef.current = true
    if (historyRefreshTimeoutRef.current !== null) window.clearTimeout(historyRefreshTimeoutRef.current)
    historyRefreshTimeoutRef.current = window.setTimeout(() => {
      historyRefreshTimeoutRef.current = null
      void fetchHistory('reconcile')
    }, 0)
  }, [fetchHistory])

  const scheduleHistoryRefresh = useCallback((delay = 100) => {
    if (pendingQueueAppendRef.current) {
      scheduleAtomicRecovery()
      return
    }
    if (historyRefreshTimeoutRef.current !== null) window.clearTimeout(historyRefreshTimeoutRef.current)
    historyRefreshTimeoutRef.current = window.setTimeout(() => {
      historyRefreshTimeoutRef.current = null
      void fetchHistory('reconcile')
    }, delay)
  }, [fetchHistory, scheduleAtomicRecovery])

  const subscribeRealtime = useCallback(() => {
    let unsubscribe = () => {}
    unsubscribe = webUiRealtime.subscribeSession(sessionId, {
      onOpen: () => {
        setConnectionState('connected')
        setReconnectCountdown(0)
        if (historyBootstrapStartedRef.current) {
          reconnectAwaitingStateRef.current = true
          return
        }
        historyBootstrapStartedRef.current = true
        void fetchHistory('bootstrap').then((sessionExists) => {
          if (sessionExists) return
          unsubscribe()
          setConnectionState('disconnected')
        })
      },
      onStatus: (status, retryInSeconds) => {
        setConnectionState(status)
        setReconnectCountdown(retryInSeconds || 0)
      },
      onMessage: data => {
        try {
        if (data.type === 'session-event' && data.event?.type === 'session-control-feedback') {
          const feedback = parseSessionControlFeedback(data.event.feedback)
          if (!feedback || data.event.requestId !== lastControlIdRef.current) return
          setControlFeedback(feedback)
          if (feedback.status === 'accepted' && pendingControlRef.current) {
            window.clearTimeout(pendingControlRef.current.timer)
            if (feedback.action === 'continue' && !sessionBusyRef.current || feedback.action === 'stop' && sessionBusyRef.current) pendingControlRef.current.accepted = true
            else clearPendingControl()
          } else clearPendingControl()
          return
        }
        if (data.type === 'session-state') {
          historyStateEventVersionRef.current += 1
          const hadSessionState = sessionStateInitializedRef.current
          const previousQueueLength = sessionQueueLengthRef.current
          const previousMessageCount = sessionMessageCountRef.current
          const previousHistoryVersion = sessionHistoryVersionRef.current
          const nextQueueLength = typeof data.session?.queueLength === 'number' ? data.session.queueLength : 0
          const nextMessageCount = typeof data.session?.messageCount === 'number' ? data.session.messageCount : 0
          const nextHistoryVersion = typeof data.session?.historyVersion === 'number' ? data.session.historyVersion : 0
          setSessionMissing(false)
          applySessionState(data.session)
          if (!hadSessionState) return
          if (!fullHistoryLoadedRef.current) {
            if (reconnectAwaitingStateRef.current && historyInFlightRef.current === null) scheduleHistoryRefresh()
            return
          }
          if (nextQueueLength !== previousQueueLength
            || (nextQueueLength === 0 && queuedMessagesRef.current.length > 0)) {
            queueRefreshNeededRef.current = true
          }
          if (reconnectAwaitingStateRef.current
            || nextMessageCount !== previousMessageCount
            || nextHistoryVersion !== previousHistoryVersion
            || queueRefreshNeededRef.current) {
            if (pendingQueueAppendRef.current) scheduleAtomicRecovery()
            else scheduleHistoryRefresh()
          }
          return
        }

        if (data.type === 'session-deleted') {
          archiveRequestRef.current?.abort()
          dispatchTimeline({ type: 'archive', messages: [], reset: true })
          historyRequestGateRef.current.invalidate()
          historyAbortControllerRef.current?.abort()
          historyAbortControllerRef.current = null
          historyInFlightRef.current = null
          historyTrailingRefreshRef.current = false
          historyEventsRef.current = []
          if (historyRefreshTimeoutRef.current !== null) {
            window.clearTimeout(historyRefreshTimeoutRef.current)
            historyRefreshTimeoutRef.current = null
          }
          setSessionMissing(true)
          setSessionBusy(false)
          setSessionQueueLength(0)
          setQueuedMessages([])
          setMessages([])
          setPersistentMemorySnapshot('')
          clearStreamingAssistantDraft()
          setHistoryLoaded(true)
          lastKnownTimestampRef.current = 0
          sessionBusyRef.current = false
          sessionQueueLengthRef.current = 0
          sessionMessageCountRef.current = 0
          sessionHistoryVersionRef.current = 0
          representedMessageCountRef.current = 0
          representedHistoryVersionRef.current = 0
          latestCommittedSeqRef.current = 0
          hasTrustedHistoryFrontierRef.current = false
          fullHistoryLoadedRef.current = true
          setIsFullHistoryLoaded(true)
          queuedMessagesRef.current = []
          pendingQueueAppendRef.current = null
          atomicRecoveryScheduledRef.current = false
          unsubscribe()
          setConnectionState('disconnected')
          return
        }

        if (data.type === 'model-stream-snapshot') {
          historyModelStreamEventVersionRef.current += 1
          const next = applyModelStreamSnapshot(data.draft || null)
          streamingAssistantDraftRef.current = next
          setStreamingAssistantDraft(next)
          return
        }

        if (data.type === 'session-event') {
          const sessionEvent = data.event as SessionStreamEvent
          if (sessionEvent.type === 'model-stream-reset') {
            historyModelStreamEventVersionRef.current += 1
            const next = applyModelStreamEvent(streamingAssistantDraftRef.current, sessionEvent)
            streamingAssistantDraftRef.current = next
            setStreamingAssistantDraft(next)
          } else if (sessionEvent.type === 'model-stream-update') {
            historyModelStreamEventVersionRef.current += 1
            const next = applyModelStreamEvent(streamingAssistantDraftRef.current, sessionEvent)
            streamingAssistantDraftRef.current = next
            setStreamingAssistantDraft(next)
          } else if (sessionEvent.type === 'toolscript-progress' && sessionEvent.toolUseId) {
            setToolScriptProgress(prev => ({
              ...prev,
              [sessionEvent.toolUseId!]: sessionEvent.subCalls || [],
            }))
          }
          return
        }

        if (data.type === 'history-append') {
          const incomingMessages = Array.isArray(data.messages) ? data.messages as Message[] : []
          const seqs = incomingMessages.map(message => message.__meta?.seq).filter((seq): seq is number => Number.isSafeInteger(seq))
          const startSeq = seqs.length ? Math.min(...seqs) : 0
          const endSeq = seqs.length ? Math.max(...seqs) : 0
          const historyVersion = Number.isSafeInteger(data.historyVersion) ? data.historyVersion : 0
          if (historyVersion === representedHistoryVersionRef.current && hasTrustedHistoryFrontierRef.current && endSeq > 0 && endSeq <= latestCommittedSeqRef.current) return
          let batchFrontier = latestCommittedSeqRef.current
          let batchHasGap = false
          if (hasTrustedHistoryFrontierRef.current) {
            for (const seq of [...new Set(seqs)].sort((left, right) => left - right)) {
              const next = advanceHistorySeqFrontier(batchFrontier, seq)
              batchFrontier = next.latestSeq
              batchHasGap ||= next.gapDetected
            }
          }
          const stateMatches = historyVersion === sessionHistoryVersionRef.current
            && data.messageCount === sessionMessageCountRef.current
            && data.queueLength === sessionQueueLengthRef.current
          if (!stateMatches || batchHasGap || pendingQueueAppendRef.current || historyInFlightRef.current?.sessionId === sessionId) {
            const existing = pendingQueueAppendRef.current
            pendingQueueAppendRef.current = existing && existing.historyVersion === historyVersion
              ? { historyVersion, startSeq: Math.min(existing.startSeq, startSeq), endSeq: Math.max(existing.endSeq, endSeq) }
              : { historyVersion, startSeq, endSeq }
            historyGapDetectedRef.current = true
            queueRefreshNeededRef.current = true
            scheduleAtomicRecovery()
            return
          }
          dispatchTimeline({
            type: 'atomic',
            archiveMessages: incomingMessages,
            messages: currentMessages => {
              const merged = mergeHistoryMessages(currentMessages, incomingMessages)
              representedMessageCountRef.current = countCommittedHistoryMessages(merged)
              return merged
            },
            queuedMessages: Array.isArray(data.queuedMessages) ? data.queuedMessages : [],
          })
          queuedMessagesRef.current = Array.isArray(data.queuedMessages) ? data.queuedMessages : []
          for (const message of incomingMessages) {
            const clientMessageId = getClientMessageId(message)
            if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
          }
          representedHistoryVersionRef.current = historyVersion
          latestCommittedSeqRef.current = hasTrustedHistoryFrontierRef.current ? batchFrontier : Math.max(latestCommittedSeqRef.current, endSeq)
          hasTrustedHistoryFrontierRef.current = endSeq > 0 || hasTrustedHistoryFrontierRef.current
          queueRefreshNeededRef.current = false
          historyGapDetectedRef.current = false
          return
        }

        if (data.type === 'message') {
          const incomingMessage = data.message as Message
          const pendingQueueAppend = pendingQueueAppendRef.current
          if (pendingQueueAppend && Number.isSafeInteger(incomingMessage.__meta?.seq)
            && (incomingMessage.__meta?.seq as number) >= pendingQueueAppend.startSeq) {
            historyGapDetectedRef.current = true
            scheduleAtomicRecovery()
            return
          }
          const msgTimestamp = data.message.__meta?.timestamp
          const isCommandResponse = data.message.__meta?.isCommandResponse
          const isUpdateExisting = data.message.__meta?.updateExisting

          if (data.message.role === 'model') {
            const next = reconcileCommittedModelDraft(streamingAssistantDraftRef.current, incomingMessage)
            if (next !== streamingAssistantDraftRef.current) {
              streamingAssistantDraftRef.current = next
              setStreamingAssistantDraft(next)
            }
          }

          if (sessionQueueLengthRef.current > 0 || queuedMessagesRef.current.length > 0) {
            queueRefreshNeededRef.current = true
            scheduleHistoryRefresh()
          }

          const hasStableIdentity = hasStableHistoryIdentity(incomingMessage)
          if (!isCommandResponse && !isUpdateExisting && !hasStableIdentity
            && msgTimestamp && msgTimestamp <= lastKnownTimestampRef.current) {
            return
          }

          const clientMessageId = getClientMessageId(incomingMessage)
          if (clientMessageId) pendingSentMessageIdsRef.current.delete(clientMessageId)
          historyEventVersionRef.current += 1
          if (historyAbortControllerRef.current) {
            historyEventsRef.current.push({
              version: historyEventVersionRef.current,
              message: incomingMessage,
            })
          }

          if (fullHistoryLoadedRef.current && !isCommandResponse && !isUpdateExisting) {
            const frontier = advanceHistorySeqFrontier(latestCommittedSeqRef.current, incomingMessage.__meta?.seq)
            latestCommittedSeqRef.current = frontier.latestSeq
            if (frontier.gapDetected) historyGapDetectedRef.current = true
          }

          setMessages(prev => {
            const beforeCount = countCommittedHistoryMessages(prev)
            const next = reconcileHistoryMessage(prev, incomingMessage)
            representedMessageCountRef.current += countCommittedHistoryMessages(next) - beforeCount
            return next
          }, [incomingMessage])

          if (fullHistoryLoadedRef.current && historyGapDetectedRef.current) scheduleHistoryRefresh()

          if (msgTimestamp && !isCommandResponse && !isUpdateExisting) {
            lastKnownTimestampRef.current = Math.max(lastKnownTimestampRef.current, msgTimestamp)
          }

          // Clean up toolscript progress when tool response message arrives
          if (data.message.role === 'tool') {
            const responseIds = (data.message.parts || [])
              .filter((p: MessagePart) => p.functionResponse)
              .map((p: MessagePart) => p.functionResponse!.tool_use_id)
              .filter(Boolean) as string[]
            if (responseIds.length > 0) {
              setToolScriptProgress(prev => {
                const hasMatch = responseIds.some(id => prev[id])
                if (!hasMatch) return prev
                const next = { ...prev }
                for (const id of responseIds) {
                  delete next[id]
                }
                return next
              })
            }
          }
        }
        } catch (e) {
          console.error('Failed to process realtime message:', e)
        }
      },
    })
    return unsubscribe
  }, [applySessionState, clearStreamingAssistantDraft, clearPendingControl, fetchHistory, scheduleAtomicRecovery, scheduleHistoryRefresh, sessionId])

  useEffect(() => {
    const unsubscribe = subscribeRealtime()

    return () => {
      unsubscribe()
      if (historyRefreshTimeoutRef.current !== null) {
        window.clearTimeout(historyRefreshTimeoutRef.current)
        historyRefreshTimeoutRef.current = null
      }
      historyRequestGateRef.current.invalidate()
      historyAbortControllerRef.current?.abort()
      historyAbortControllerRef.current = null
      historyInFlightRef.current = null
      historyTrailingRefreshRef.current = false
    }
  }, [subscribeRealtime])

  const sendSessionCommand = useCallback(async (command: string): Promise<boolean> => {
    if (sessionMissing) return false
    const action = getSessionControlAction(command)
    if (pendingControlRef.current && action !== 'stop') return false
    const id = globalThis.crypto?.randomUUID?.() || `control-${Date.now()}-${Math.random().toString(36).slice(2)}`
    if (action) {
      clearPendingControl()
      lastControlIdRef.current = id
      const timer = window.setTimeout(() => {
        if (pendingControlRef.current?.id !== id) return
        clearPendingControl()
        setControlFeedback({ action, status: 'error', message: 'Action not confirmed', details: 'Check the session state before trying again.' })
      }, 30000)
      pendingControlRef.current = { id, action, timer, accepted: false, queuedAtStart: sessionQueueLengthRef.current }
      setPendingControl(action)
      setControlFeedback(null)
    }
    try {
      const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: command, ...(action ? { controlRequestId: id } : {}) }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || `Command failed (${response.status})`)
      }
      return true
    } catch (error) {
      if (action && pendingControlRef.current?.id === id) {
        clearPendingControl()
        setControlFeedback({ action, status: 'error', message: 'Action not confirmed', details: error instanceof Error ? error.message.slice(0, 4096) : 'The request could not be completed.' })
      }
      return false
    }
  }, [clearPendingControl, sessionId, sessionMissing])

  const sendMessage = useCallback(async ({ text, attachments }: { text: string; attachments: Array<{ ref: string; file: File }> }) => {
    if (sessionMissing || (!text.trim() && attachments.length === 0) || loading) return false
    if (!webUiIdentityMode && attachments.length === 0 && getSessionControlAction(text)) return sendSessionCommand(text.trim())

    setControlFeedback(null)
    setLoading(true)

    const userMessage = text.trim()
    const isSlashCommand = /^\/[a-zA-Z_\-.]+(?:\s+.*)?$/s.test(userMessage)
    const files = [...attachments]
    const sendTimestamp = Date.now()
    const clientMessageId = globalThis.crypto?.randomUUID?.()
      || `webui-${sendTimestamp}-${Math.random().toString(36).slice(2)}`

    const parts: any[] = []
    let messageText = userMessage
    let requestText = userMessage
    let uploadedFiles
    try {
      uploadedFiles = await uploadReferencedFiles(files, `${API_BASE_PATH}/upload`, fetch, webUiIdentityMode ? sessionId : undefined)
    } catch (err) {
      console.error('File upload failed:', err)
      setLoading(false)
      setMessages(prev => [...prev, { role: 'model', parts: [{ text: `Error: ${err instanceof Error ? err.message : 'Failed to upload attachment'}` }], __meta: { temporary: true, timestamp: Date.now() } }])
      return false
    }

    const attachmentDisplays = uploadedFiles.map(file => ({
      ref: file.ref,
      name: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      kind: file.mimeType.startsWith('image/') ? 'image' : 'file',
    } as const))

    if (requestText) {
      parts.push({ text: requestText })
    }

    const previewParts = buildReferencedAttachmentParts(messageText, attachmentDisplays)

    const appendOptimistic = !isSlashCommand
      && shouldAppendOptimisticMessage(sessionBusyRef.current, sessionQueueLengthRef.current)
    if (appendOptimistic) {
      pendingSentMessageIdsRef.current.add(clientMessageId)
      setMessages(prev => [...prev, buildOptimisticUserMessage({
        clientMessageId,
        parts: previewParts,
        timestamp: sendTimestamp,
      })])
    }

    try {
      await postReferencedMessage(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/message`, {
          parts,
          uploadedFiles: toLegacyUploadedFiles(uploadedFiles),
          ...(!isSlashCommand ? { clientMessageId } : {}),
      })
      if (!appendOptimistic && !isSlashCommand) {
        queueRefreshNeededRef.current = true
        scheduleHistoryRefresh()
      }
    } catch (e) {
      console.error('Failed to send message:', e)
      pendingSentMessageIdsRef.current.delete(clientMessageId)
      setMessages(prev => {
          const hasReconciledRow = prev.some(message => (
            !message.__meta?.optimistic
            && getClientMessageId(message) === clientMessageId
          ))
          const hasPendingOptimisticRow = prev.some(message => (
            message.__meta?.optimistic
            && getClientMessageId(message) === clientMessageId
          ))
          if (appendOptimistic && (hasReconciledRow || !hasPendingOptimisticRow)) return prev
          return [
            ...prev.filter(message => !(
              message.__meta?.optimistic
              && getClientMessageId(message) === clientMessageId
            )),
            createLocalSessionNotice('Message not confirmed', 'Draft kept.', e instanceof Error ? e.message : 'Failed to send message'),
          ]
      })
      setLoading(false)
      return false
    }

    setLoading(false)
    return true
  }, [loading, scheduleHistoryRefresh, sendSessionCommand, sessionId, sessionMissing, webUiIdentityMode])


  // Confirmed settings do not advance history/runtime authority or invalidate an active draft.
  const mergeConfirmedSettings = useCallback((settings: ConfirmedSessionSettings) => {
    setSessionRecord(previous => ({ ...(previous || { id: sessionId }), ...settings }))
  }, [sessionId])

  const retryEarlierHistory = useCallback(() => {
    setEarlierHistoryError(false)
    return fetchHistory('full')
  }, [fetchHistory])

  useEffect(() => {
    if (historyMode !== 'continuous' || connectionState !== 'connected' || sessionMissing || archivePage.loading) return
    if (archiveSnapshotRevisionRef.current === historySnapshotRevision) return
    archiveSnapshotRevisionRef.current = historySnapshotRevision
    void loadArchivePage(archiveBoundaryRef.current.firstSeq === undefined ? 'initial' : 'later')
  }, [historyMode, connectionState, historySnapshotRevision, loadArchivePage, sessionMissing, archivePage.loading])

  useEffect(() => () => { archiveRequestRef.current?.abort() }, [sessionId])

  const continuousMessages = useMemo(() => {
    const canonicalClientIds = new Set(timelineState.archiveMessages.map(getClientMessageId).filter(Boolean))
    return [...timelineState.archiveMessages, ...messages.filter(message => message.__meta?.temporary
      && (!getClientMessageId(message) || !canonicalClientIds.has(getClientMessageId(message))))]
  }, [messages, timelineState.archiveMessages])

  return {
    continuousMessages,
    archivePage,
    loadArchivePage,
    messages,
    queuedMessages,
    sessionRecord,
    sessionMissing,
    sessionBusy,
    sessionQueueLength,
    pendingControl,
    controlFeedback,
    persistentMemorySnapshot,
    streamingAssistantDraft,
    toolScriptProgress,
    historyLoaded,
    isFullHistoryLoaded,
    earlierHistoryError,
    connectionState,
    reconnectCountdown,
    loading,
    retryEarlierHistory,
    sendMessage,
    sendSessionCommand,
    mergeConfirmedSettings,
  }
}

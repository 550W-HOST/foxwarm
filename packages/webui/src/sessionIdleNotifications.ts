import { useCallback, useEffect, useRef, useState } from 'react'
import { getSessionRuntimeStateName, isSessionRuntimeActive, type RuntimeStateSessionLike } from './sessionRuntimeState'
import { readSessionIdleUnread, SESSION_IDLE_SESSION_DELETED_EVENT, SESSION_IDLE_UNREAD_EVENT, SESSION_IDLE_UNREAD_STORAGE_KEY, shouldMarkSessionIdleUnread, updateStoredSessionIdleUnread, type SessionIdleUnread } from './sessionIdleAttention'

export type SessionIdleNotificationMode = 'once' | 'always'

export interface SessionIdleNotificationSession extends RuntimeStateSessionLike {
  id: string
  displayName?: string
  aliases?: string[]
}

export interface SessionIdleNotificationHandle {
  onclick: ((event: Event) => unknown) | null
  onclose: ((event: Event) => unknown) | null
  close(): void
}

type OpenSessionFromNotification = (sessionId: string) => void | Promise<void>

type SessionIdleNotificationModes = Record<string, SessionIdleNotificationMode>

type SessionIdleNotificationBaseline = {
  state: string
  sawBusy: boolean
}

export const SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY = 'foxwarm_session_idle_notifications_v1'

function isSessionIdleNotificationMode(value: unknown): value is SessionIdleNotificationMode {
  return value === 'once' || value === 'always'
}

export function readSessionIdleNotificationModes(storage: Pick<Storage, 'getItem'>): SessionIdleNotificationModes {
  try {
    const raw = storage.getItem(SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.entries(parsed).reduce<SessionIdleNotificationModes>((modes, [sessionId, mode]) => {
      if (sessionId && isSessionIdleNotificationMode(mode)) {
        modes[sessionId] = mode
      }
      return modes
    }, {})
  } catch {
    return {}
  }
}

export function writeSessionIdleNotificationModes(storage: Pick<Storage, 'setItem' | 'removeItem'>, modes: SessionIdleNotificationModes): void {
  try {
    if (Object.keys(modes).length === 0) {
      storage.removeItem(SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY)
      return
    }
    storage.setItem(SESSION_IDLE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // Browser storage can be unavailable or full. Keep the in-memory setting for this page.
  }
}

export function requestSessionIdleNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') {
    return Promise.resolve(false)
  }
  if (Notification.permission === 'granted') {
    return Promise.resolve(true)
  }

  return Notification.requestPermission()
    .then(permission => permission === 'granted')
    .catch(() => false)
}

export function showSessionIdleNotification(session: SessionIdleNotificationSession): SessionIdleNotificationHandle | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return null
  }

  try {
    return new Notification('Session idle', {
      body: session.displayName || session.id,
    })
  } catch {
    return null
  }
}

/** Owns only the page-created Notification handles registered by one live WebUI root. */
export class SessionIdleNotificationRegistry {
  private notifications = new Map<string, Set<SessionIdleNotificationHandle>>()

  constructor(private readonly focusPage: () => void = () => {
    window.focus()
    if (window.parent !== window) window.parent.focus()
  }) {}

  retain(sessionId: string, notification: SessionIdleNotificationHandle, openSession: OpenSessionFromNotification): void {
    const owned = this.notifications.get(sessionId) || new Set<SessionIdleNotificationHandle>()
    owned.add(notification)
    this.notifications.set(sessionId, owned)

    notification.onclick = () => {
      this.remove(sessionId, notification)
      try { notification.close() } catch { /* Best-effort browser/OS cleanup. */ }
      try { this.focusPage() } catch { /* The browser may reject focus. */ }
      try {
        Promise.resolve(openSession(sessionId)).catch(() => undefined)
      } catch {
        // Navigation failures do not restore a notification that the user already clicked.
      }
    }
    notification.onclose = () => this.remove(sessionId, notification)
  }

  closeSession(sessionId: string): void {
    const owned = this.notifications.get(sessionId)
    if (!owned) return
    for (const notification of [...owned]) {
      this.remove(sessionId, notification)
      try { notification.close() } catch { /* Best-effort browser/OS cleanup. */ }
    }
  }

  closeSessions(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) this.closeSession(sessionId)
  }

  closeMissingUnread(unreadSessionIds: ReadonlySet<string>): void {
    for (const sessionId of [...this.notifications.keys()]) {
      if (!unreadSessionIds.has(sessionId)) this.closeSession(sessionId)
    }
  }

  closeAll(): void {
    this.closeSessions([...this.notifications.keys()])
  }

  count(sessionId?: string): number {
    if (sessionId) return this.notifications.get(sessionId)?.size || 0
    return [...this.notifications.values()].reduce((total, owned) => total + owned.size, 0)
  }

  private remove(sessionId: string, notification: SessionIdleNotificationHandle): void {
    const owned = this.notifications.get(sessionId)
    if (!owned?.delete(notification)) return
    if (owned.size === 0) this.notifications.delete(sessionId)
    try { notification.onclick = null } catch { /* Ignore host-object assignment failures. */ }
    try { notification.onclose = null } catch { /* Ignore host-object assignment failures. */ }
  }
}

export class SessionIdleNotificationTracker {
  private baselines = new Map<string, SessionIdleNotificationBaseline>()

  arm(session: SessionIdleNotificationSession): void {
    this.baselines.set(session.id, {
      state: getSessionRuntimeStateName(session),
      sawBusy: isSessionRuntimeActive(session),
    })
  }

  disarm(sessionId: string): void {
    this.baselines.delete(sessionId)
  }

  observe(sessions: SessionIdleNotificationSession[], modes: SessionIdleNotificationModes): SessionIdleNotificationSession[] {
    const sessionIds = new Set(sessions.map(session => session.id))
    const notifications: SessionIdleNotificationSession[] = []

    for (const sessionId of this.baselines.keys()) {
      if (!sessionIds.has(sessionId) || !modes[sessionId]) {
        this.baselines.delete(sessionId)
      }
    }

    for (const session of sessions) {
      const mode = modes[session.id]
      if (!mode) continue

      const state = getSessionRuntimeStateName(session)
      const isBusy = isSessionRuntimeActive(session)
      const previous = this.baselines.get(session.id)

      if (!previous) {
        this.baselines.set(session.id, { state, sawBusy: isBusy })
        continue
      }

      const sawBusy = previous.sawBusy || isBusy
      if (previous.state !== 'idle' && state === 'idle' && sawBusy) {
        notifications.push(session)
        this.baselines.set(session.id, { state, sawBusy: false })
      } else {
        this.baselines.set(session.id, { state, sawBusy })
      }
    }

    return notifications
  }
}

function loadStoredSessionIdleNotificationModes(): SessionIdleNotificationModes {
  return typeof localStorage === 'undefined' ? {} : readSessionIdleNotificationModes(localStorage)
}

export function useSessionIdleNotifications(sessions: SessionIdleNotificationSession[], options: {
  visibleSessionIds?: Iterable<string>
  onOpenSession?: OpenSessionFromNotification
} = {}) {
  const [modes, setModes] = useState<SessionIdleNotificationModes>(loadStoredSessionIdleNotificationModes)
  const [unread, setUnread] = useState<SessionIdleUnread>(() => typeof localStorage === 'undefined' ? {} : readSessionIdleUnread(localStorage))
  const modesRef = useRef(modes)
  const sessionsRef = useRef(sessions)
  const trackerRef = useRef(new SessionIdleNotificationTracker())
  const notificationRegistryRef = useRef<SessionIdleNotificationRegistry | null>(null)
  const openSessionRef = useRef(options.onOpenSession)

  if (!notificationRegistryRef.current) notificationRegistryRef.current = new SessionIdleNotificationRegistry()

  modesRef.current = modes
  sessionsRef.current = sessions
  openSessionRef.current = options.onOpenSession
  const visibleSessionIds = new Set(options.visibleSessionIds || [])
  const canonicalVisibleSessionIds = new Set([...visibleSessionIds].map(sessionId => (
    sessions.find(session => session.id === sessionId || session.aliases?.includes(sessionId))?.id || sessionId
  )))

  const updateModes = useCallback((update: (current: SessionIdleNotificationModes) => SessionIdleNotificationModes) => {
    setModes(current => {
      const next = update(current)
      modesRef.current = next
      if (typeof localStorage !== 'undefined') {
        writeSessionIdleNotificationModes(localStorage, next)
        window.dispatchEvent(new Event('foxwarm-idle-watch-changed'))
      }
      return next
    })
  }, [])

  useEffect(() => {
    for (const session of trackerRef.current.observe(sessions, modesRef.current)) {
      if (shouldMarkSessionIdleUnread(session.id, canonicalVisibleSessionIds, document.visibilityState) && typeof localStorage !== 'undefined') {
        const next = updateStoredSessionIdleUnread(localStorage, current => ({ ...current, [session.id]: Date.now() }))
        setUnread(next)
        window.dispatchEvent(new Event(SESSION_IDLE_UNREAD_EVENT))
      }
      const notification = showSessionIdleNotification(session)
      if (notification) {
        notificationRegistryRef.current?.retain(session.id, notification, canonicalSessionId => {
          return openSessionRef.current?.(canonicalSessionId)
        })
        if (!shouldMarkSessionIdleUnread(session.id, canonicalVisibleSessionIds, document.visibilityState)) {
          notificationRegistryRef.current?.closeSession(session.id)
        }
      }
      if (notification && modesRef.current[session.id] === 'once') {
        updateModes(current => {
          const { [session.id]: _removed, ...remaining } = current
          return remaining
        })
      }
    }
  }, [sessions, updateModes, [...canonicalVisibleSessionIds].join('\0')])

  const acknowledgeSession = useCallback((sessionId: string) => {
    if (!sessionId || document.visibilityState !== 'visible' || typeof localStorage === 'undefined') return
    const canonicalId = sessionsRef.current.find(session => session.id === sessionId || session.aliases?.includes(sessionId))?.id || sessionId
    notificationRegistryRef.current?.closeSession(canonicalId)
    const next = updateStoredSessionIdleUnread(localStorage, current => {
      if (!(canonicalId in current)) return current
      const { [canonicalId]: _removed, ...remaining } = current
      return remaining
    })
    setUnread(next)
    window.dispatchEvent(new Event(SESSION_IDLE_UNREAD_EVENT))
  }, [])

  const acknowledgeVisibleSessions = useCallback((sessionIds: Iterable<string>) => {
    if (document.visibilityState !== 'visible') return
    for (const sessionId of sessionIds) acknowledgeSession(sessionId)
  }, [acknowledgeSession])

  const clearDeletedSessions = useCallback((sessionIds: Iterable<string>) => {
    const deleted = new Set(sessionIds)
    if (deleted.size === 0) return
    notificationRegistryRef.current?.closeSessions(deleted)
    if (typeof localStorage === 'undefined') return
    const next = updateStoredSessionIdleUnread(localStorage, current => Object.fromEntries(Object.entries(current).filter(([sessionId]) => !deleted.has(sessionId))))
    setUnread(next)
    window.dispatchEvent(new Event(SESSION_IDLE_UNREAD_EVENT))
  }, [])

  useEffect(() => {
    const handleDeleted = (event: Event) => {
      const sessionIds = (event as CustomEvent<{ sessionIds?: unknown }>).detail?.sessionIds
      if (Array.isArray(sessionIds)) clearDeletedSessions(sessionIds.filter((value): value is string => typeof value === 'string'))
    }
    window.addEventListener(SESSION_IDLE_SESSION_DELETED_EVENT, handleDeleted)
    return () => window.removeEventListener(SESSION_IDLE_SESSION_DELETED_EVENT, handleDeleted)
  }, [clearDeletedSessions])

  useEffect(() => {
    const sync = () => {
      if (typeof localStorage === 'undefined') return
      const next = readSessionIdleUnread(localStorage)
      notificationRegistryRef.current?.closeMissingUnread(new Set(Object.keys(next)))
      setUnread(next)
    }
    const handleStorage = (event: StorageEvent) => { if (!event.key || event.key === SESSION_IDLE_UNREAD_STORAGE_KEY) sync() }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(SESSION_IDLE_UNREAD_EVENT, sync)
    return () => { window.removeEventListener('storage', handleStorage); window.removeEventListener(SESSION_IDLE_UNREAD_EVENT, sync) }
  }, [])

  useEffect(() => () => notificationRegistryRef.current?.closeAll(), [])

  useEffect(() => {
    const acknowledgeCurrentVisibility = () => {
      if (document.visibilityState === 'visible') acknowledgeVisibleSessions(canonicalVisibleSessionIds)
    }
    acknowledgeCurrentVisibility()
    document.addEventListener('visibilitychange', acknowledgeCurrentVisibility)
    return () => document.removeEventListener('visibilitychange', acknowledgeCurrentVisibility)
  }, [[...canonicalVisibleSessionIds].join('\0'), acknowledgeVisibleSessions])

  const toggleMode = useCallback(async (sessionId: string, mode: SessionIdleNotificationMode) => {
    const currentMode = modesRef.current[sessionId]
    if (currentMode === mode) {
      trackerRef.current.disarm(sessionId)
      updateModes(current => {
        const { [sessionId]: _removed, ...remaining } = current
        return remaining
      })
      return
    }

    if (currentMode) {
      updateModes(current => ({ ...current, [sessionId]: mode }))
      return
    }

    if (!await requestSessionIdleNotificationPermission()) {
      return
    }

    const currentSession = sessionsRef.current.find(session => session.id === sessionId)
    if (!currentSession) return

    trackerRef.current.arm(currentSession)
    updateModes(current => ({ ...current, [sessionId]: mode }))
  }, [updateModes])

  return { idleNotificationModes: modes, toggleIdleNotificationMode: toggleMode, unreadSessionIds: new Set(Object.keys(unread)), acknowledgeSession, acknowledgeVisibleSessions, clearDeletedSessions }
}

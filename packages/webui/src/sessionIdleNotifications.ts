import { useCallback, useEffect, useRef, useState } from 'react'
import { getSessionRuntimeStateName, isSessionRuntimeActive, type RuntimeStateSessionLike } from './sessionRuntimeState'

export type SessionIdleNotificationMode = 'once' | 'always'

export interface SessionIdleNotificationSession extends RuntimeStateSessionLike {
  id: string
  displayName?: string
}

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

export function showSessionIdleNotification(session: SessionIdleNotificationSession): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false
  }

  try {
    new Notification('Session idle', {
      body: session.displayName || session.id,
    })
    return true
  } catch {
    return false
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

export function useSessionIdleNotifications(sessions: SessionIdleNotificationSession[]) {
  const [modes, setModes] = useState<SessionIdleNotificationModes>(loadStoredSessionIdleNotificationModes)
  const modesRef = useRef(modes)
  const sessionsRef = useRef(sessions)
  const trackerRef = useRef(new SessionIdleNotificationTracker())

  modesRef.current = modes
  sessionsRef.current = sessions

  const updateModes = useCallback((update: (current: SessionIdleNotificationModes) => SessionIdleNotificationModes) => {
    setModes(current => {
      const next = update(current)
      modesRef.current = next
      if (typeof localStorage !== 'undefined') {
        writeSessionIdleNotificationModes(localStorage, next)
      }
      return next
    })
  }, [])

  useEffect(() => {
    for (const session of trackerRef.current.observe(sessions, modesRef.current)) {
      if (!showSessionIdleNotification(session)) continue
      if (modesRef.current[session.id] === 'once') {
        updateModes(current => {
          const { [session.id]: _removed, ...remaining } = current
          return remaining
        })
      }
    }
  }, [sessions, updateModes])

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

  return { idleNotificationModes: modes, toggleIdleNotificationMode: toggleMode }
}

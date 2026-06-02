import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { API_BASE_PATH } from '../config'
import { MoreVertical, Archive, ArchiveRestore, GitFork, Pencil, Trash2, ArrowUpFromDot } from 'lucide-react'
import ContextMenu, { type ContextMenuAnchorRect, type ContextMenuEntry } from './ContextMenu'

export interface Session {
  id: string
  agent?: string
  messageCount: number
  lastMessageTime: number
  parentSessionId: string | null
  childSessions: string[]
  aliases?: string[]
  busy?: boolean
  busyStartedAt?: number | null
  queueLength?: number
  displayName?: string
  archived?: boolean
  currentNode?: string
  cwd?: string | null
  model?: string | null
  modelKey?: string
  defaultModelKey?: string
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  isolated?: boolean
  tokenUsage?: {
    cachedTokens: number
    inputTokens: number
    outputTokens: number
  }
}

interface SessionListCoreProps {
  sessions: Session[]
  currentSession?: string  // Optional, for highlighting in sidebar
  onSelectSession: (sessionId: string) => void
  onKeepSession?: (sessionId: string) => void
}

interface ContextMenuState {
  sessionId: string
  x: number
  y: number
  anchorRect?: ContextMenuAnchorRect
  preferredPlacement?: 'point' | 'bottom-start' | 'bottom-end'
}

const FOXWARM_TOKEN_KEY = 'foxwarm_token'
const LEGACY_TOKEN_KEY = 'alphabot_token'
const DEFAULT_VISIBLE_CHILDREN = 5
const MORE_VISIBLE_CHILDREN_STEP = 10

const getStoredAuthToken = () => {
  const foxwarmToken = localStorage.getItem(FOXWARM_TOKEN_KEY)
  if (foxwarmToken) {
    return foxwarmToken
  }

  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY)
  if (legacyToken) {
    localStorage.setItem(FOXWARM_TOKEN_KEY, legacyToken)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    return legacyToken
  }

  return null
}

const formatPromoteApiError = async (response: Response): Promise<string> => {
  const status = `${response.status} ${response.statusText}`.trim()
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json() as {
        error?: string
        message?: string
        reason?: string
        code?: string
        operation?: string
        sessionBusy?: boolean
        targetParentBusy?: boolean
      }
      const mainMessage = payload.error || payload.message || payload.reason
      const codeSuffix = payload.code ? ` [${payload.code}]` : ''
      const busyNote = payload.sessionBusy
        ? '\n\nNote: the session is currently busy. Parent/child relation updates are intended to be allowed while a session is busy; if this keeps happening, wait for the run to finish and retry.'
        : ''
      return `${mainMessage || `Request failed with ${status}`}${codeSuffix}${busyNote}`
    } catch (err) {
      console.warn('[PROMOTE] Failed to parse JSON error response:', err)
    }
  }

  try {
    const text = (await response.text()).trim()
    if (text) {
      return `Request failed with ${status}: ${text.slice(0, 500)}`
    }
  } catch (err) {
    console.warn('[PROMOTE] Failed to read error response text:', err)
  }

  return `Request failed with ${status}`
}

const formatPromoteNetworkError = (err: unknown, session?: Session): string => {
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown network error')
  const normalizedMessage = rawMessage || 'Unknown network error'
  const browserFetchHint = /failed to fetch|networkerror|load failed/i.test(normalizedMessage)
    ? 'The browser could not reach the Foxwarm API. This usually means the backend or Vite proxy restarted, the dev proxy is temporarily unavailable, or the page has a stale app shell.'
    : 'The browser request failed before Foxwarm returned a structured error.'
  const busyNote = session?.busy
    ? '\n\nThe selected session is currently busy, but that is not supposed to block promote/move-up by itself. If this was a transient API/proxy failure, refresh the WebUI or wait for the run to finish and retry.'
    : ''

  return `${browserFetchHint}\n\nRaw browser error: ${normalizedMessage}${busyNote}`
}

const findScrollableParent = (element: HTMLElement | null): HTMLElement | null => {
  if (!element) return null

  const taggedContainer = element.closest('[data-session-list-scroll-container]') as HTMLElement | null
  if (taggedContainer) {
    return taggedContainer
  }

  let current = element.parentElement || null

  while (current) {
    const style = window.getComputedStyle(current)
    const overflowY = style.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }

  return null
}

const isFullyVisibleInContainer = (element: HTMLElement, container: HTMLElement) => {
  const elementRect = element.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()

  return elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom
}

function DraggableSessionRow({
  session,
  children,
  className,
  onClick,
  onDoubleClick,
  onContextMenu,
  setRowRef,
}: {
  session: Session
  children: ReactNode
  className: string
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  setRowRef: (node: HTMLDivElement | null) => void
}) {
  const title = session.displayName || session.id
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session:${session.id}`,
    data: {
      type: 'session',
      sessionId: session.id,
      title,
    },
  })

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        setRowRef(node)
      }}
      className={`${className} ${isDragging ? 'opacity-50' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

export default function SessionListCore({ sessions, currentSession, onSelectSession, onKeepSession }: SessionListCoreProps) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [visibleChildCounts, setVisibleChildCounts] = useState<Map<string, number>>(new Map())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSubmitting, setRenameSubmitting] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const sessionRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const [pendingFocusSessionId, setPendingFocusSessionId] = useState<string | null>(null)

  const sortSessions = (a: Session, b: Session) => {
    if (a.archived && !b.archived) return 1
    if (!a.archived && b.archived) return -1
    return (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
  }

  const sessionMap = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])

  const aliasMap = useMemo(() => {
    const map = new Map<string, string>()

    for (const session of sessions) {
      map.set(session.id, session.id)
      for (const alias of session.aliases || []) {
        map.set(alias, session.id)
      }
    }

    return map
  }, [sessions])

  const resolveSessionId = (sessionId: string | null | undefined) => {
    if (!sessionId) return null
    return aliasMap.get(sessionId) || null
  }

  const normalizedParentMap = useMemo(() => {
    const map = new Map<string, string | null>()

    for (const session of sessions) {
      const resolvedParentId = resolveSessionId(session.parentSessionId)
      map.set(
        session.id,
        resolvedParentId && resolvedParentId !== session.id && sessionMap.has(resolvedParentId)
          ? resolvedParentId
          : null
      )
    }

    return map
  }, [sessions, sessionMap, aliasMap])

  const childrenMap = useMemo(() => {
    const map = new Map<string, Session[]>()

    for (const session of sessions) {
      const parentId = normalizedParentMap.get(session.id)
      if (!parentId) continue

      if (!map.has(parentId)) {
        map.set(parentId, [])
      }
      map.get(parentId)!.push(session)
    }

    for (const children of map.values()) {
      children.sort(sortSessions)
    }

    return map
  }, [sessions, normalizedParentMap])

  const descendantBusyCountMap = useMemo(() => {
    const map = new Map<string, number>()

    const countBusyDescendants = (sessionId: string): number => {
      if (map.has(sessionId)) {
        return map.get(sessionId) || 0
      }

      const children = childrenMap.get(sessionId) || []
      const total = children.reduce((sum, child) => {
        const childBusy = child.busy ? 1 : 0
        return sum + childBusy + countBusyDescendants(child.id)
      }, 0)

      map.set(sessionId, total)
      return total
    }

    for (const session of sessions) {
      countBusyDescendants(session.id)
    }

    return map
  }, [childrenMap, sessions])

  const rootSessions = useMemo(
    () => sessions.filter(session => !normalizedParentMap.get(session.id)).sort(sortSessions),
    [sessions, normalizedParentMap]
  )

  const resolvedCurrentSessionId = currentSession ? resolveSessionId(currentSession) || currentSession : undefined

  useEffect(() => {
    if (!resolvedCurrentSessionId) return

    const sessionsToExpand = new Set<string>()
    let currentId: string | null = resolvedCurrentSessionId

    while (currentId) {
      sessionsToExpand.add(currentId)
      currentId = normalizedParentMap.get(currentId) || null
    }

    setExpandedSessions(prev => {
      let changed = false
      const next = new Set(prev)

      sessionsToExpand.forEach(sessionId => {
        if (!next.has(sessionId)) {
          next.add(sessionId)
          changed = true
        }
      })

      return changed ? next : prev
    })

    setPendingFocusSessionId(resolvedCurrentSessionId)
  }, [resolvedCurrentSessionId, normalizedParentMap])

  useEffect(() => {
    if (!pendingFocusSessionId) return

    const target = sessionRefs.current.get(pendingFocusSessionId)
    if (!target) return

    const frame = window.requestAnimationFrame(() => {
      const scrollParent = findScrollableParent(target)

      if (!scrollParent || !isFullyVisibleInContainer(target, scrollParent)) {
        target.scrollIntoView({ block: 'nearest' })
      }

      setPendingFocusSessionId(null)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [pendingFocusSessionId, expandedSessions, rootSessions.length])

  useEffect(() => {
    if (!renameSessionId) return

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [renameSessionId])

  const toggleExpand = (sessionId: string) => {
    const newExpanded = new Set(expandedSessions)
    if (newExpanded.has(sessionId)) {
      newExpanded.delete(sessionId)
    } else {
      newExpanded.add(sessionId)
    }
    setExpandedSessions(newExpanded)
  }

  const toggleShowMore = (sessionId: string) => {
    setVisibleChildCounts(prev => {
      const next = new Map(prev)
      const currentCount = next.get(sessionId) ?? DEFAULT_VISIBLE_CHILDREN
      const totalChildren = childrenMap.get(sessionId)?.length ?? 0

      if (currentCount >= totalChildren) {
        next.delete(sessionId)
      } else {
        next.set(sessionId, currentCount + MORE_VISIBLE_CHILDREN_STEP)
      }

      return next
    })
  }

  // Get display ID for a session, removing parent prefix if applicable
  const getDisplayId = (session: Session, parentSession: Session | null) => {
    if (!parentSession) return session.id
    if (session.id.startsWith(parentSession.id)) {
      return session.id.slice(parentSession.id.length)
    }
    return session.id
  }

  // Handle right click
  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      sessionId,
      x: e.clientX,
      y: e.clientY,
      preferredPlacement: 'point',
    })
  }

  // Handle menu button click (for mobile)
  const handleMenuClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    
    // Position menu below button, right-aligned to prevent overflow on mobile
    setContextMenu({
      sessionId,
      x: rect.left,
      y: rect.bottom,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      preferredPlacement: 'bottom-end',
    })
  }

  // API calls
  const deleteSession = async (sessionId: string) => {
    try {
      const token = getStoredAuthToken()
      const url = `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}`
      console.log('[DELETE] Sending request to:', url)
      console.log('[DELETE] Token:', token ? 'present' : 'missing')
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
      
      console.log('[DELETE] Response status:', response.status)
      console.log('[DELETE] Response ok:', response.ok)
      
      if (!response.ok) {
        const error = await response.json()
        console.error('[DELETE] Error response:', error)
        alert(`Failed to delete session: ${error.error}`)
      } else {
        console.log('[DELETE] Success')
      }
    } catch (err) {
      console.error('[DELETE] Exception:', err)
      alert('Failed to delete session')
    }
    setContextMenu(null)
    setDeleteConfirm(null)
  }

  const toggleArchive = async (sessionId: string, archived: boolean) => {
    try {
      const token = getStoredAuthToken()
      const url = `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/archive`
      console.log('[ARCHIVE] Sending request to:', url)
      console.log('[ARCHIVE] Token:', token ? 'present' : 'missing')
      console.log('[ARCHIVE] Body:', { archived })
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ archived })
      })
      
      console.log('[ARCHIVE] Response status:', response.status)
      console.log('[ARCHIVE] Response ok:', response.ok)
      
      if (!response.ok) {
        const error = await response.json()
        console.error('[ARCHIVE] Error response:', error)
        alert(`Failed to archive session: ${error.error}`)
      } else {
        console.log('[ARCHIVE] Success')
      }
    } catch (err) {
      console.error('[ARCHIVE] Exception:', err)
      alert('Failed to archive session')
    }
    setContextMenu(null)
  }

  const forkSession = async (sessionId: string) => {
    try {
      const token = getStoredAuthToken()
      const url = `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/fork`
      console.log('[FORK] Sending request to:', url)
      console.log('[FORK] Token:', token ? 'present' : 'missing')
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
      
      console.log('[FORK] Response status:', response.status)
      console.log('[FORK] Response ok:', response.ok)
      
      if (!response.ok) {
        const error = await response.json()
        console.error('[FORK] Error response:', error)
        alert(`Failed to fork session: ${error.error}`)
      } else {
        const result = await response.json()
        console.log('[FORK] Success, new session:', result.newSessionId)
        // Optionally switch to the new session
        onSelectSession(result.newSessionId)
      }
    } catch (err) {
      console.error('[FORK] Exception:', err)
      alert('Failed to fork session')
    }
    setContextMenu(null)
  }

  const promoteSession = async (sessionId: string, targetParentId?: string) => {
    const targetSession = sessionMap.get(sessionId)
    const operationLabel = targetParentId ? 'move session up one level' : 'promote session to root'

    try {
      const token = getStoredAuthToken()
      const url = `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/promote`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ targetParentId: targetParentId || null })
      })

      if (!response.ok) {
        const errorMessage = await formatPromoteApiError(response)
        alert(`Could not ${operationLabel}.\n\n${errorMessage}`)
      }
    } catch (err) {
      console.error('[PROMOTE] Exception:', err)
      alert(`Could not ${operationLabel}.\n\n${formatPromoteNetworkError(err, targetSession)}`)
    }
    setContextMenu(null)
  }

  const openRenameDialog = (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    setRenameSessionId(sessionId)
    setRenameValue(session?.displayName || '')
    setContextMenu(null)
  }

  const renameSession = async () => {
    if (!renameSessionId || renameSubmitting) return

    try {
      setRenameSubmitting(true)
      const token = getStoredAuthToken()
      const url = `${API_BASE_PATH}/sessions/${encodeURIComponent(renameSessionId)}/name`

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: renameValue })
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }))
        alert(`Failed to rename session: ${error.error || 'Unknown error'}`)
        return
      }

      setRenameSessionId(null)
      setRenameValue('')
    } catch (err) {
      console.error('[RENAME] Exception:', err)
      alert('Failed to rename session')
    } finally {
      setRenameSubmitting(false)
    }
  }

  const renderSession = (session: Session, level: number = 0, parentSession: Session | null = null) => {
    const children = childrenMap.get(session.id) || []
    const hasChildren = children.length > 0
    const descendantBusyCount = descendantBusyCountMap.get(session.id) || 0
    const isExpanded = expandedSessions.has(session.id)
    const visibleCount = visibleChildCounts.get(session.id) ?? DEFAULT_VISIBLE_CHILDREN
    const visibleChildren = children.slice(0, visibleCount)
    const hiddenCount = children.length - visibleChildren.length
    const contentPaddingLeft = `${12 + level * 16}px`

    // Get display ID (with parent prefix removed if applicable)
    const displayId = getDisplayId(session, parentSession)

    const isCurrentSession = resolvedCurrentSessionId === session.id

    return (
      <div
        key={session.id}
      >
        <DraggableSessionRow
          session={session}
          className={`flex items-center rounded cursor-pointer mt-1 ${
            isCurrentSession
              ? 'bg-blue-100 dark:bg-blue-900/30' 
              : 'hover:bg-gray-100 dark:hover:bg-gray-700'
          } ${session.archived ? 'opacity-70' : ''}`}
          onClick={() => onSelectSession(session.id)}
          onDoubleClick={() => onKeepSession?.(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
          setRowRef={(node) => {
            sessionRefs.current.set(session.id, node)
          }}
        >
          <div className="flex-1 min-w-0 py-3 pr-2" style={{ paddingLeft: contentPaddingLeft }}>
            <div className="font-medium truncate text-gray-900 dark:text-white text-sm">
              {session.displayName || displayId}
              {session.archived && (
                <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">[Archived]</span>
              )}
            </div>
            {session.displayName && (
              <div className="text-xs text-gray-400 dark:text-gray-500 font-mono truncate">
                {displayId}
              </div>
            )}
            <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {session.busy && (
                <>
                  <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-300">
                    <span className="inline-flex items-center gap-0.5">
                      <span className="w-1.5 h-1.5 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce"></span>
                      <span className="w-1.5 h-1.5 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></span>
                      <span className="w-1.5 h-1.5 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                    </span>
                    <span>busy</span>
                  </span>
                  <span>•</span>
                </>
              )}
              {!!session.queueLength && (
                <>
                  <span>{session.queueLength} queued</span>
                  <span>•</span>
                </>
              )}
              <span>{session.messageCount || 0} msgs</span>
            </div>
            {session.cwd && (
              <div className="mt-1 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500" title={session.cwd}>
                cwd: {session.cwd}
              </div>
            )}
            {hasChildren && (
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(session.id)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="-ml-1 -my-1 inline-flex items-center gap-x-1.5 gap-y-0.5 rounded px-1 py-1 text-left text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:text-gray-400 dark:hover:text-gray-200"
                  title={isExpanded ? 'Collapse child sessions' : 'Expand child sessions'}
                  aria-label={isExpanded ? 'Collapse child sessions' : 'Expand child sessions'}
                  aria-expanded={isExpanded}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isExpanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    )}
                  </svg>
                  <span>{children.length} {children.length === 1 ? 'child' : 'children'}</span>
                  {descendantBusyCount > 0 && (
                    <>
                      <span>•</span>
                      <span className="text-blue-600 dark:text-blue-300">{descendantBusyCount} busy</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
          {/* Menu button - only visible on mobile */}
          <button
            onClick={(e) => handleMenuClick(e, session.id)}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded md:hidden"
            title="More options"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </DraggableSessionRow>

        {hasChildren && isExpanded && (
          <div>
            {visibleChildren.map(child => renderSession(child, level + 1, session))}
            {hiddenCount > 0 && (
              <button
                onClick={() => toggleShowMore(session.id)}
                className="w-full text-left p-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                style={{ paddingLeft: `${28 + (level + 1) * 16}px` }}
              >
                {`▼ Show ${Math.min(hiddenCount, MORE_VISIBLE_CHILDREN_STEP)} more...`}
              </button>
            )}
            {hiddenCount <= 0 && children.length > DEFAULT_VISIBLE_CHILDREN && (
              <button
                onClick={() => toggleShowMore(session.id)}
                className="w-full text-left p-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                style={{ paddingLeft: `${28 + (level + 1) * 16}px` }}
              >
                ▲ Show less
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const contextMenuEntries: ContextMenuEntry[] = contextMenu ? (() => {
    const session = sessionMap.get(contextMenu.sessionId)
    const isArchived = session?.archived || false
    const hasParent = !!session?.parentSessionId
    const parentSession = hasParent ? sessionMap.get(session!.parentSessionId!) : undefined
    const grandparentId = parentSession?.parentSessionId || undefined

    return [
      {
        key: 'rename',
        icon: <Pencil size={14} />,
        label: 'Rename',
        onSelect: () => openRenameDialog(contextMenu.sessionId),
      },
      {
        key: 'archive',
        icon: isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />,
        label: isArchived ? 'Unarchive' : 'Archive',
        onSelect: () => { void toggleArchive(contextMenu.sessionId, !isArchived) },
      },
      {
        key: 'fork',
        icon: <GitFork size={14} />,
        label: 'Fork',
        onSelect: () => { void forkSession(contextMenu.sessionId) },
      },
      ...(hasParent && grandparentId ? [{
        key: 'promote-up',
        icon: <ArrowUpFromDot size={14} />,
        label: `Move up one level`,
        onSelect: () => { void promoteSession(contextMenu.sessionId, grandparentId) },
      }] : []),
      ...(hasParent ? [{
        key: 'promote',
        icon: <ArrowUpFromDot size={14} />,
        label: 'Promote to root',
        onSelect: () => { void promoteSession(contextMenu.sessionId) },
      }] : []),
      { key: 'divider-1', type: 'separator' },
      {
        key: 'delete',
        icon: <Trash2 size={14} />,
        label: 'Delete',
        danger: true,
        onSelect: () => setDeleteConfirm(contextMenu.sessionId),
      },
    ] as ContextMenuEntry[]
  })() : []

  return (
    <>
      {rootSessions.map(session => renderSession(session))}

      <ContextMenu
        open={!!contextMenu}
        entries={contextMenuEntries}
        point={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        anchorRect={contextMenu?.anchorRect || null}
        preferredPlacement={contextMenu?.preferredPlacement || 'point'}
        onClose={() => setContextMenu(null)}
      />

      {/* Rename Dialog */}
      {renameSessionId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Rename Session
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Display name
                </label>
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      renameSession()
                    }
                    if (e.key === 'Escape') {
                      setRenameSessionId(null)
                      setRenameValue('')
                    }
                  }}
                  placeholder="Enter a custom chat name"
                  className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Session ID: <span className="font-mono text-xs">{renameSessionId}</span>
                <br />
                Leave the display name empty to clear it.
              </p>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setRenameSessionId(null)
                  setRenameValue('')
                }}
                className="px-4 py-2 text-sm rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
                disabled={renameSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={() => renameSession()}
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                disabled={renameSubmitting}
              >
                {renameSubmitting ? 'Saving...' : (renameValue.trim() ? 'Save' : 'Clear name')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Delete Session
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Are you sure you want to delete session <span className="font-mono text-sm">{deleteConfirm}</span>?
              This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteSession(deleteConfirm)}
                className="px-4 py-2 text-sm rounded bg-red-600 text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

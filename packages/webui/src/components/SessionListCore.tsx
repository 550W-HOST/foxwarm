import { useState, useRef, useEffect, useMemo } from 'react'
import { API_BASE_PATH } from '../config'
import { MoreVertical, Archive, ArchiveRestore, GitFork, Pencil, Trash2 } from 'lucide-react'

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
}

interface ContextMenuState {
  sessionId: string
  x: number
  y: number
  isRightClick?: boolean // Track if it's from right-click or button click
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

export default function SessionListCore({ sessions, currentSession, onSelectSession }: SessionListCoreProps) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [visibleChildCounts, setVisibleChildCounts] = useState<Map<string, number>>(new Map())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSubmitting, setRenameSubmitting] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
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

  const rootSessions = useMemo(
    () => sessions.filter(session => !normalizedParentMap.get(session.id)).sort(sortSessions),
    [sessions, normalizedParentMap]
  )

  const resolvedCurrentSessionId = currentSession ? resolveSessionId(currentSession) || currentSession : undefined

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    
    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu])

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
      isRightClick: true // Mark as right-click for positioning
    })
  }

  // Handle menu button click (for mobile)
  const handleMenuClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    
    // Position menu below button, right-aligned to prevent overflow on mobile
    setContextMenu({
      sessionId,
      x: rect.right, // Use right edge of button
      y: rect.bottom + 4,
      isRightClick: false // Mark as button click for right-aligned positioning
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
    const isExpanded = expandedSessions.has(session.id)
    const visibleCount = visibleChildCounts.get(session.id) ?? DEFAULT_VISIBLE_CHILDREN
    const visibleChildren = children.slice(0, visibleCount)
    const hiddenCount = children.length - visibleChildren.length

    // Get display ID (with parent prefix removed if applicable)
    const displayId = getDisplayId(session, parentSession)

    const isCurrentSession = resolvedCurrentSessionId === session.id

    return (
      <div
        key={session.id}
      >
        <div
          ref={(node) => {
            sessionRefs.current.set(session.id, node)
          }}
          className={`flex items-center rounded cursor-pointer mt-1 ${
            isCurrentSession
              ? 'bg-blue-100 dark:bg-blue-900/30' 
              : 'hover:bg-gray-100 dark:hover:bg-gray-700'
          } ${session.archived ? 'opacity-70' : ''}`}
          onClick={() => onSelectSession(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
        >
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(session.id)
              }}
              className="self-stretch flex items-center px-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              style={{ marginLeft: `${level * 16}px` }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0 py-3 pr-2" style={{ paddingLeft: hasChildren ? '0' : `${12 + level * 16}px` }}>
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
              {hasChildren && (
                <>
                  <span>•</span>
                  <span>{children.length} {children.length === 1 ? 'child' : 'children'}</span>
                </>
              )}
            </div>
            {session.cwd && (
              <div className="mt-1 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500" title={session.cwd}>
                cwd: {session.cwd}
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
        </div>

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

  return (
    <>
      {rootSessions.map(session => renderSession(session))}
      
      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1 z-50"
          style={
            contextMenu.isRightClick
              ? {
                  // Right-click: left-align at cursor
                  left: `${contextMenu.x}px`,
                  top: `${contextMenu.y}px`
                }
              : {
                  // Button click: right-align from button
                  right: `${window.innerWidth - contextMenu.x}px`,
                  top: `${contextMenu.y}px`
                }
          }
        >
          {(() => {
            const session = sessionMap.get(contextMenu.sessionId)
            const isArchived = session?.archived || false
            
            return (
              <>
                <button
                  onClick={() => openRenameDialog(contextMenu.sessionId)}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 inline-flex items-center gap-2"
                >
                  <Pencil size={14} />
                  <span>Rename</span>
                </button>
                <button
                  onClick={() => toggleArchive(contextMenu.sessionId, !isArchived)}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 inline-flex items-center gap-2"
                >
                  {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  <span>{isArchived ? 'Unarchive' : 'Archive'}</span>
                </button>
                <button
                  onClick={() => forkSession(contextMenu.sessionId)}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 inline-flex items-center gap-2"
                >
                  <GitFork size={14} />
                  <span>Fork</span>
                </button>
                <button
                  onClick={() => {
                    setDeleteConfirm(contextMenu.sessionId)
                    setContextMenu(null)
                  }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 inline-flex items-center gap-2"
                >
                  <Trash2 size={14} />
                  <span>Delete</span>
                </button>
              </>
            )
          })()}
        </div>
      )}

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

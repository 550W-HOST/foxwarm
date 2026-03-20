import { useState, useEffect, useRef } from 'react'
import Chat from './components/Chat'
import ArchitectureView from './components/ArchitectureView'
import SessionList from './components/SessionList'
import Sidebar from './components/Sidebar'
import WorkspaceView from './components/WorkspaceView'
import type { Session } from './components/SessionListCore'
import { API_BASE_PATH } from './config'

type ThemeMode = 'auto' | 'light' | 'dark'
type AppView = 'chat' | 'architecture' | 'workspace'

const LIGHT_THEME_COLOR = '#f3f4f6'
const DARK_THEME_COLOR = '#111827'
const ARCHITECTURE_HASH = '__architecture__'
const WORKSPACE_HASH_PREFIX = '__workspace__:'

const getHashState = (): { view: AppView; sessionId: string } => {
  const hash = decodeURIComponent(window.location.hash.slice(1))

  if (!hash || hash.startsWith('token=')) {
    return { view: 'chat', sessionId: 'main' }
  }

  if (hash === ARCHITECTURE_HASH) {
    return { view: 'architecture', sessionId: 'main' }
  }

  if (hash.startsWith(WORKSPACE_HASH_PREFIX)) {
    const sessionId = hash.slice(WORKSPACE_HASH_PREFIX.length) || 'main'
    return { view: 'workspace', sessionId }
  }

  return { view: 'chat', sessionId: hash }
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentView, setCurrentView] = useState<AppView>(() => getHashState().view)
  const [currentSession, setCurrentSession] = useState<string>(() => getHashState().sessionId)
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 768)
  const [showSessionList, setShowSessionList] = useState<boolean>(() => {
    // Show session list if no hash (mobile only)
    return !window.location.hash
  })
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('themeMode')
    return saved === 'auto' || saved === 'light' || saved === 'dark' ? saved : 'auto'
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  const darkMode = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark)
  
  const globalSSERef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectDelayRef = useRef<number>(1000)

  useEffect(() => {
    // Apply dark mode class to html element
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      darkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR
    )
  }, [darkMode])

  useEffect(() => {
    localStorage.setItem('themeMode', themeMode)
  }, [themeMode])

  useEffect(() => {
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemPrefersDark(e.matches)
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    // Listen for window resize
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const connectGlobalSSE = () => {
    // Clear any existing connection
    if (globalSSERef.current) {
      globalSSERef.current.close()
      globalSSERef.current = null
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    console.log('Connecting to global SSE...')

    const es = new EventSource(`${API_BASE_PATH}/sessions/stream`)
    
    es.onopen = () => {
      console.log('Global SSE connected')
      // Reset reconnect delay on successful connection
      reconnectDelayRef.current = 1000
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'sessions-updated') {
          console.log('Session list updated, refetching...')
          fetchSessions()
        }
      } catch (e) {
        console.error('Failed to parse SSE message:', e)
      }
    }
    
    es.onerror = (err) => {
      console.error('Global SSE error:', err)
      es.close()
      
      // Check if we should reconnect
      if (es.readyState === EventSource.CLOSED) {
        // Calculate next delay (exponential backoff, max 30s)
        const delay = Math.min(reconnectDelayRef.current, 30000)
        console.log(`Reconnecting global SSE in ${delay}ms...`)
        
        // Schedule reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          // Refresh sessions before reconnecting
          fetchSessions().then(() => {
            connectGlobalSSE()
          })
          
          // Increase delay for next time (exponential backoff)
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000)
        }, delay)
      }
    }
    
    globalSSERef.current = es
  }

  useEffect(() => {
    fetchSessions()
    connectGlobalSSE()
    
    return () => {
      if (globalSSERef.current) {
        globalSSERef.current.close()
        globalSSERef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
    }
  }, [])

  // Listen for hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const nextState = getHashState()

      if (window.location.hash) {
        setCurrentView(nextState.view)
        setCurrentSession(nextState.sessionId)
        if (isMobile) {
          setShowSessionList(false)
        }
      } else {
        setCurrentView('chat')
        setCurrentSession('main')
        if (isMobile) {
          setShowSessionList(true)
        }
      }
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [isMobile])

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE_PATH}/sessions`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions)
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e)
    }
  }

  const handleSelectSession = (sessionId: string) => {
    window.location.hash = encodeURIComponent(sessionId)
    setCurrentView('chat')
    setCurrentSession(sessionId)
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const handleSelectArchitecture = () => {
    window.location.hash = ARCHITECTURE_HASH
    setCurrentView('architecture')
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const handleSelectWorkspace = (sessionId?: string) => {
    const targetSessionId = sessionId || currentSession || 'main'
    window.location.hash = `${WORKSPACE_HASH_PREFIX}${encodeURIComponent(targetSessionId)}`
    setCurrentView('workspace')
    setCurrentSession(targetSessionId)
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const handleCreateSession = () => {
    fetch(`${API_BASE_PATH}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create session')
      }

      if (!data.sessionId) {
        throw new Error('Missing sessionId in create response')
      }

      await fetchSessions()
      handleSelectSession(data.sessionId)
    }).catch((err) => {
      console.error('Failed to create session:', err)
      window.alert(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const handleBackToList = () => {
    window.location.hash = ''
    setShowSessionList(true)
    fetchSessions() // Refresh session list
  }

  // Expose test functions globally
  useEffect(() => {
    const helper = {
      sendMessage: (message: string) => {
        if (!currentSession) {
          console.error('No current session')
          return
        }
        fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(currentSession)}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message })
        }).then(res => {
          if (res.ok) console.log('Message sent:', message)
          else console.error('Failed to send message')
        }).catch(err => console.error('Send error:', err))
      },
      switchToSession: (sessionId: string) => {
        handleSelectSession(sessionId)
        console.log('Switched to session:', sessionId)
      }
    }

    ;(window as any).foxwarmTest = helper
    // Temporary compatibility alias for existing test scripts
    ;(window as any).alphabotTest = helper
  }, [currentSession])

  const currentSessionRecord = sessions.find(session => session.id === currentSession || session.aliases?.includes(currentSession))

  // Mobile view
  if (isMobile) {
    if (showSessionList) {
      return <SessionList 
        sessions={sessions} 
        currentSession={currentView === 'chat' ? currentSession : undefined}
        currentView={currentView}
        onSelectSession={handleSelectSession}
        onSelectArchitecture={handleSelectArchitecture}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateSession={handleCreateSession}
      />
    }

    if (currentView === 'architecture') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <ArchitectureView
            sessions={sessions}
            currentSession={currentSession}
            onSelectSession={handleSelectSession}
            onBack={handleBackToList}
          />
        </div>
      )
    }

    if (currentView === 'workspace') {
      return (
        <div className="fixed inset-0 overflow-hidden bg-gray-100 dark:bg-gray-900">
          <WorkspaceView
            sessionId={currentSession}
            session={currentSessionRecord}
            onBack={handleBackToList}
            onSessionsChanged={() => { void fetchSessions() }}
          />
        </div>
      )
    }

    return (
      <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <Chat 
          key={currentSession}
          sessionId={currentSession}
          sessionDisplayName={currentSessionRecord?.displayName}
          onBack={handleBackToList}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
        />
      </div>
    )
  }

  // Desktop view
  return (
    <div className="flex bg-gray-100 dark:bg-gray-900 h-screen">
      <Sidebar 
        sessions={sessions}
        currentSession={currentView === 'chat' ? currentSession : ''}
        currentView={currentView}
        onSelectSession={handleSelectSession}
        onSelectArchitecture={handleSelectArchitecture}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateSession={handleCreateSession}
      />
      <div className="flex-1 h-screen overflow-hidden">
        {currentView === 'architecture' ? (
          <ArchitectureView
            sessions={sessions}
            currentSession={currentSession}
            onSelectSession={handleSelectSession}
          />
        ) : currentView === 'workspace' ? (
          <WorkspaceView
            sessionId={currentSession}
            session={currentSessionRecord}
            onSessionsChanged={() => { void fetchSessions() }}
          />
        ) : (
          <Chat 
            key={currentSession}
            sessionId={currentSession}
            sessionDisplayName={currentSessionRecord?.displayName}
            onBack={handleBackToList}
            themeMode={themeMode}
            onThemeChange={setThemeMode}
          />
        )}
      </div>
    </div>
  )
}

export default App

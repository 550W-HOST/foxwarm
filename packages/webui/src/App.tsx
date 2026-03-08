import { useState, useEffect, useRef } from 'react'
import Chat from './components/Chat'
import SessionList from './components/SessionList'
import Sidebar from './components/Sidebar'
import { API_BASE_PATH } from './config'

type ThemeMode = 'auto' | 'light' | 'dark'

function App() {
  const [sessions, setSessions] = useState<any[]>([])
  const [currentSession, setCurrentSession] = useState<string>(() => {
    // Read from hash on initial load
    const hash = window.location.hash.slice(1) // Remove #
    // Ignore token parameter
    if (hash.startsWith('token=')) {
      return 'main'
    }
    return hash || 'main'
  })
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
      const hash = window.location.hash.slice(1)
      if (hash && !hash.startsWith('token=')) {
        setCurrentSession(hash)
        if (isMobile) {
          setShowSessionList(false)
        }
      } else if (isMobile) {
        setShowSessionList(true)
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
    window.location.hash = sessionId
    setCurrentSession(sessionId)
    if (isMobile) {
      setShowSessionList(false)
    }
  }

  const handleCreateSession = () => {
    const now = new Date()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const rand = Math.random().toString(36).slice(2, 7)
    const newSessionId = `${mm}${dd}_${rand}`

    // Switch to new session
    handleSelectSession(newSessionId)
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
  }, [currentSession])

  // Mobile view
  if (isMobile) {
    if (showSessionList) {
      return <SessionList 
        sessions={sessions} 
        currentSession={currentSession}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
      />
    }
    return (
      <div className="fixed inset-0 bg-gray-100 dark:bg-gray-900 overflow-hidden">
        <Chat 
          key={currentSession}
          sessionId={currentSession} 
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
        currentSession={currentSession}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
      />
      <div className="flex-1 h-screen overflow-hidden">
        <Chat 
          key={currentSession}
          sessionId={currentSession} 
          onBack={handleBackToList}
          themeMode={themeMode}
          onThemeChange={setThemeMode}
        />
      </div>
    </div>
  )
}

export default App

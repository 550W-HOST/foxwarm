import { useBoundedSessionList } from '../boundedSessionList'
import CollapsedSidebar from './CollapsedSidebar'

interface CollapsedSidebarContainerProps {
  currentSession: string
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onToggleCollapsed: () => void
  unreadSessionIds?: ReadonlySet<string>
}

export default function CollapsedSidebarContainer(props: CollapsedSidebarContainerProps) {
  const collapsedSessions = useBoundedSessionList({
    focusIds: props.currentSession ? [props.currentSession] : [],
    rootLimit: 20,
    childLimit: 1,
    includeIdleWatches: false,
  })

  return <CollapsedSidebar {...props} sessions={collapsedSessions.sessions} />
}
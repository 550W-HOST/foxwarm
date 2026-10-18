import type { HistoryMode } from './continuousHistory'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

export type SendKeyMode = 'modEnter' | 'enter'
export type TimelineView = 'detailed' | 'grouped' | 'conversation'

export type ChatPreferences = {
  sendKeyMode: SendKeyMode
  timelineView: TimelineView
  showUsageBadge: boolean
  showUserMessageMetadata: boolean
  showInterAgentMessages: boolean
  showCommentary: boolean
  fullWidth: boolean
}

const SEND_KEY_MODE_STORAGE_KEY = 'foxwarm_send_key_mode_v1'
const GROUP_TOOLS_STORAGE_KEY = 'foxwarm_group_tools_v1'
const TIMELINE_VIEW_STORAGE_KEY = 'foxwarm_timeline_view_v1'
const MOBILE_TIMELINE_VIEW_STORAGE_KEY = 'foxwarm_mobile_timeline_view_v1'
const SHOW_USAGE_BADGE_STORAGE_KEY = 'foxwarm_show_usage_badge_v1'
const SHOW_USER_MESSAGE_METADATA_STORAGE_KEY = 'foxwarm_show_user_message_metadata_v1'
const SHOW_INTER_AGENT_MESSAGES_STORAGE_KEY = 'foxwarm_show_inter_agent_messages_v1'
const SHOW_COMMENTARY_STORAGE_KEY = 'foxwarm_show_commentary_v1'
const FULL_WIDTH_STORAGE_KEY = 'foxwarm_chat_full_width_v1'
const CHAT_PREFERENCE_STORAGE_KEYS = new Set([
  SEND_KEY_MODE_STORAGE_KEY,
  GROUP_TOOLS_STORAGE_KEY,
  TIMELINE_VIEW_STORAGE_KEY,
  MOBILE_TIMELINE_VIEW_STORAGE_KEY,
  SHOW_USAGE_BADGE_STORAGE_KEY,
  SHOW_USER_MESSAGE_METADATA_STORAGE_KEY,
  FULL_WIDTH_STORAGE_KEY,
  SHOW_INTER_AGENT_MESSAGES_STORAGE_KEY,
  SHOW_COMMENTARY_STORAGE_KEY,
])

const mobileQuery = '(max-width: 767px)'
function subscribeMobileViewport(notify: () => void) {
  const query = window.matchMedia(mobileQuery)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
/** Root viewport policy, independent of a compact desktop split pane. */
export function useMobileChatViewport() {
  return useSyncExternalStore(subscribeMobileViewport, () => window.innerWidth < 768, () => false)
}

export function readChatPreferences(mobile = false): ChatPreferences {
  const storedView = localStorage.getItem(mobile ? MOBILE_TIMELINE_VIEW_STORAGE_KEY : TIMELINE_VIEW_STORAGE_KEY)
  const timelineView = storedView === 'detailed' || storedView === 'grouped' || storedView === 'conversation'
    ? storedView
    : mobile ? 'conversation' : localStorage.getItem(GROUP_TOOLS_STORAGE_KEY) === 'true' ? 'grouped' : 'detailed'
  return {
    sendKeyMode: localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY) === 'enter' ? 'enter' : 'modEnter',
    timelineView,
    showUsageBadge: localStorage.getItem(SHOW_USAGE_BADGE_STORAGE_KEY) !== 'false',
    showUserMessageMetadata: localStorage.getItem(SHOW_USER_MESSAGE_METADATA_STORAGE_KEY) === 'true',
    showInterAgentMessages: localStorage.getItem(SHOW_INTER_AGENT_MESSAGES_STORAGE_KEY) !== 'false',
    showCommentary: localStorage.getItem(SHOW_COMMENTARY_STORAGE_KEY) !== 'false',
    fullWidth: localStorage.getItem(FULL_WIDTH_STORAGE_KEY) !== 'false',
  }
}

export function useChatPreferences() {
  const mobile = useMobileChatViewport()
  const [preferences, setPreferences] = useState<ChatPreferences>(() => readChatPreferences(mobile))
  useEffect(() => { setPreferences(readChatPreferences(mobile)) }, [mobile])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return
      if (event.key !== null && !CHAT_PREFERENCE_STORAGE_KEYS.has(event.key)) return
      setPreferences(readChatPreferences(window.innerWidth < 768))
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const setSendKeyMode = useCallback((sendKeyMode: SendKeyMode) => {
    localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, sendKeyMode)
    setPreferences(current => current.sendKeyMode === sendKeyMode ? current : { ...current, sendKeyMode })
  }, [])

  const setTimelineView = useCallback((timelineView: TimelineView) => {
    localStorage.setItem(window.innerWidth < 768 ? MOBILE_TIMELINE_VIEW_STORAGE_KEY : TIMELINE_VIEW_STORAGE_KEY, timelineView)
    setPreferences(current => current.timelineView === timelineView ? current : { ...current, timelineView })
  }, [])

  const setShowUsageBadge = useCallback((showUsageBadge: boolean) => {
    localStorage.setItem(SHOW_USAGE_BADGE_STORAGE_KEY, showUsageBadge ? 'true' : 'false')
    setPreferences(current => current.showUsageBadge === showUsageBadge ? current : { ...current, showUsageBadge })
  }, [])

  const setShowUserMessageMetadata = useCallback((showUserMessageMetadata: boolean) => {
    localStorage.setItem(SHOW_USER_MESSAGE_METADATA_STORAGE_KEY, showUserMessageMetadata ? 'true' : 'false')
    setPreferences(current => current.showUserMessageMetadata === showUserMessageMetadata ? current : { ...current, showUserMessageMetadata })
  }, [])

  const setShowInterAgentMessages = useCallback((showInterAgentMessages: boolean) => {
    localStorage.setItem(SHOW_INTER_AGENT_MESSAGES_STORAGE_KEY, showInterAgentMessages ? 'true' : 'false')
    setPreferences(current => current.showInterAgentMessages === showInterAgentMessages ? current : { ...current, showInterAgentMessages })
  }, [])

  const setShowCommentary = useCallback((showCommentary: boolean) => {
    localStorage.setItem(SHOW_COMMENTARY_STORAGE_KEY, showCommentary ? 'true' : 'false')
    setPreferences(current => current.showCommentary === showCommentary ? current : { ...current, showCommentary })
  }, [])

  const setFullWidth = useCallback((fullWidth: boolean) => {
    localStorage.setItem(FULL_WIDTH_STORAGE_KEY, fullWidth ? 'true' : 'false')
    setPreferences(current => current.fullWidth === fullWidth ? current : { ...current, fullWidth })
  }, [])

  return {
    ...preferences,
    setSendKeyMode,
    setTimelineView,
    setShowUsageBadge,
    setShowUserMessageMetadata,
    setFullWidth,
    setShowInterAgentMessages,
    setShowCommentary,
  }
}

/** The initial settings UI couples these choices; data and rendering keep separate axes. */
export function historyModeForTimelineView(view: TimelineView): HistoryMode {
  return view === 'conversation' ? 'continuous' : 'active'
}

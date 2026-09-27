import { useCallback, useEffect, useState } from 'react'

export type SendKeyMode = 'modEnter' | 'enter'

export type ChatPreferences = {
  sendKeyMode: SendKeyMode
  groupTools: boolean
  showUsageBadge: boolean
  showUserMessageMetadata: boolean
}

const SEND_KEY_MODE_STORAGE_KEY = 'foxwarm_send_key_mode_v1'
const GROUP_TOOLS_STORAGE_KEY = 'foxwarm_group_tools_v1'
const SHOW_USAGE_BADGE_STORAGE_KEY = 'foxwarm_show_usage_badge_v1'
const SHOW_USER_MESSAGE_METADATA_STORAGE_KEY = 'foxwarm_show_user_message_metadata_v1'
const CHAT_PREFERENCE_STORAGE_KEYS = new Set([
  SEND_KEY_MODE_STORAGE_KEY,
  GROUP_TOOLS_STORAGE_KEY,
  SHOW_USAGE_BADGE_STORAGE_KEY,
  SHOW_USER_MESSAGE_METADATA_STORAGE_KEY,
])

export function readChatPreferences(): ChatPreferences {
  return {
    sendKeyMode: localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY) === 'enter' ? 'enter' : 'modEnter',
    groupTools: localStorage.getItem(GROUP_TOOLS_STORAGE_KEY) === 'true',
    showUsageBadge: localStorage.getItem(SHOW_USAGE_BADGE_STORAGE_KEY) !== 'false',
    showUserMessageMetadata: localStorage.getItem(SHOW_USER_MESSAGE_METADATA_STORAGE_KEY) === 'true',
  }
}

export function useChatPreferences() {
  const [preferences, setPreferences] = useState<ChatPreferences>(readChatPreferences)

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return
      if (event.key !== null && !CHAT_PREFERENCE_STORAGE_KEYS.has(event.key)) return
      setPreferences(readChatPreferences())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const setSendKeyMode = useCallback((sendKeyMode: SendKeyMode) => {
    localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, sendKeyMode)
    setPreferences(current => current.sendKeyMode === sendKeyMode ? current : { ...current, sendKeyMode })
  }, [])

  const setGroupTools = useCallback((groupTools: boolean) => {
    localStorage.setItem(GROUP_TOOLS_STORAGE_KEY, groupTools ? 'true' : 'false')
    setPreferences(current => current.groupTools === groupTools ? current : { ...current, groupTools })
  }, [])

  const setShowUsageBadge = useCallback((showUsageBadge: boolean) => {
    localStorage.setItem(SHOW_USAGE_BADGE_STORAGE_KEY, showUsageBadge ? 'true' : 'false')
    setPreferences(current => current.showUsageBadge === showUsageBadge ? current : { ...current, showUsageBadge })
  }, [])

  const setShowUserMessageMetadata = useCallback((showUserMessageMetadata: boolean) => {
    localStorage.setItem(SHOW_USER_MESSAGE_METADATA_STORAGE_KEY, showUserMessageMetadata ? 'true' : 'false')
    setPreferences(current => current.showUserMessageMetadata === showUserMessageMetadata ? current : { ...current, showUserMessageMetadata })
  }, [])

  return {
    ...preferences,
    setSendKeyMode,
    setGroupTools,
    setShowUsageBadge,
    setShowUserMessageMetadata,
  }
}

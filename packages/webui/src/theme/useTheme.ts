import { useSyncExternalStore } from 'react'
import {
  exportTheme,
  getThemeSnapshot,
  initializeThemeRuntime,
  installTheme,
  removeTheme,
  setThemeSelection,
  subscribeThemeRuntime,
} from './runtime'

export function useTheme() {
  initializeThemeRuntime()
  const snapshot = useSyncExternalStore(subscribeThemeRuntime, getThemeSnapshot, getThemeSnapshot)
  return {
    ...snapshot,
    setThemeId: (themeId: string) => setThemeSelection({ themeId }),
    setThemeForMode: (mode: 'light' | 'dark', themeId: string) => setThemeSelection(mode === 'light' ? { lightThemeId: themeId } : { darkThemeId: themeId }),
    setColorMode: (colorMode: typeof snapshot.selection.colorMode) => setThemeSelection({ colorMode }),
    installTheme,
    removeTheme,
    exportTheme,
  }
}

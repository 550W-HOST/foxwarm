export type ContextScrollbarSettings = {
  showScrollbar: boolean
  showMinimap: boolean
}

export const CONTEXT_SCROLLBAR_SETTINGS_EVENT = 'foxwarm-context-scrollbar-settings'
const SHOW_SCROLLBAR_STORAGE_KEY = 'foxwarm.contextScrollbar.showScrollbar'
const SHOW_MINIMAP_STORAGE_KEY = 'foxwarm.contextScrollbar.showMinimap'

export const normalizeContextScrollbarSettings = (settings: ContextScrollbarSettings): ContextScrollbarSettings => (
  settings.showScrollbar || settings.showMinimap ? settings : { showScrollbar: false, showMinimap: true }
)

export const readContextScrollbarSettings = (): ContextScrollbarSettings => {
  const settings = normalizeContextScrollbarSettings({
    showScrollbar: localStorage.getItem(SHOW_SCROLLBAR_STORAGE_KEY) === 'true',
    showMinimap: localStorage.getItem(SHOW_MINIMAP_STORAGE_KEY) !== 'false',
  })
  localStorage.setItem(SHOW_SCROLLBAR_STORAGE_KEY, settings.showScrollbar ? 'true' : 'false')
  localStorage.setItem(SHOW_MINIMAP_STORAGE_KEY, settings.showMinimap ? 'true' : 'false')
  return settings
}

export const writeContextScrollbarSettings = (next: ContextScrollbarSettings) => {
  const settings = normalizeContextScrollbarSettings(next)
  localStorage.setItem(SHOW_SCROLLBAR_STORAGE_KEY, settings.showScrollbar ? 'true' : 'false')
  localStorage.setItem(SHOW_MINIMAP_STORAGE_KEY, settings.showMinimap ? 'true' : 'false')
  window.dispatchEvent(new Event(CONTEXT_SCROLLBAR_SETTINGS_EVENT))
  return settings
}

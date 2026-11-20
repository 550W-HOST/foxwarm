/**
 * The Chat input send-key rule, shared by the composer and other text fields that submit
 * (the question answer form). Takes native keyboard events; React handlers pass `nativeEvent`.
 */
import type { SendKeyMode } from './chatPreferences'

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing' | 'keyCode'>

/**
 * True while an input method is composing, including the key that commits a composition:
 * Chromium reports `isComposing`, while Safari ends composition first and reports keyCode 229.
 */
export const isImeComposing = (event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean =>
  !!event.isComposing || event.keyCode === 229

/** Ctrl/Cmd+Enter always sends; plain Enter sends only in `enter` mode, where Shift+Enter is a newline. */
export const isSendKey = (event: KeyLike, mode: SendKeyMode): boolean =>
  event.key === 'Enter'
  && !isImeComposing(event)
  && (event.ctrlKey || event.metaKey || (mode === 'enter' && !event.shiftKey))

/** Platform modifier name shown in shortcut labels. */
export const modifierKeyLabel = (platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent): string =>
  /Mac|iPhone|iPad|iPod/i.test(platform) ? 'Cmd' : 'Ctrl'

/** Visible label of the key that sends in the given mode. */
export const sendShortcutLabel = (mode: SendKeyMode, platform?: string): string =>
  mode === 'enter' ? 'Enter' : `${modifierKeyLabel(platform)}+Enter`

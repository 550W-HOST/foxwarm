/**
 * Physical-keyboard shortcuts of the browser Terminal beyond what xterm itself encodes, and
 * the page-close guard for the one browser shortcut a page cannot cancel (Ctrl+W).
 */
import { readHostFrame } from './windowFrame'

export type TerminalShortcutAction =
  /** Copy the xterm selection and clear it. */
  | 'copy'
  /** Leave the key to the browser, whose paste reaches xterm's own paste listener. */
  | 'native-paste'
  /** Send ^W (readline/vi word erase), the VS Code mapping of Ctrl+Backspace. */
  | 'word-erase'
  /** Reset the terminal font to its default size. */
  | 'font-reset'

type ShortcutKey = Pick<KeyboardEvent, 'type' | 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

export function isApplePlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

/**
 * The Terminal-owned action for a keydown, or null to keep xterm's normal encoding.
 * Ctrl+0 pairs with the Ctrl+Minus/Equal font steps everywhere. The other shortcuts apply
 * off Apple platforms, where Cmd already copies and pastes and Ctrl must reach the PTY unchanged.
 */
export function terminalShortcutAction(event: ShortcutKey, options: { apple: boolean; hasSelection: boolean }): TerminalShortcutAction | null {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return null
  if (!event.shiftKey && event.code === 'Digit0') return 'font-reset'
  if (options.apple) return null
  const letter = event.code.startsWith('Key') ? event.code.slice(3) : ''
  if (event.shiftKey) {
    if (letter === 'C') return 'copy'
    if (letter === 'V') return 'native-paste'
    return null
  }
  if (letter === 'C' && options.hasSelection) return 'copy'
  if (event.code === 'Backspace') return 'word-erase'
  return null
}

/**
 * Whether a focused, attached Terminal should ask before the page unloads. Browsers close
 * the tab on Ctrl+W without giving the page the key; on Apple platforms the close key is
 * Cmd+W, and the Desktop hosts deliver Ctrl+W to the page like any other key.
 */
export function terminalUnloadGuardApplies(options: { apple: boolean; desktopHost: boolean }): boolean {
  return !options.apple && !options.desktopHost
}

function runsInDesktopHost(): boolean {
  try { return !!readHostFrame(window.top?.foxwarmFrame) } catch { return false }
}

/**
 * Registers a beforeunload prompt only while `textarea` (xterm's input) has focus and
 * `isAttached()` holds, so ordinary page closes and reloads stay unprompted.
 */
export function attachTerminalUnloadGuard(textarea: HTMLTextAreaElement, isAttached: () => boolean): () => void {
  if (!terminalUnloadGuardApplies({ apple: isApplePlatform(), desktopHost: runsInDesktopHost() })) return () => {}
  const view = textarea.ownerDocument.defaultView || window
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (textarea.ownerDocument.activeElement !== textarea || !isAttached()) return
    event.preventDefault()
    event.returnValue = ''
  }
  let registered = false
  const register = () => {
    if (registered) return
    registered = true
    view.addEventListener('beforeunload', onBeforeUnload)
  }
  const unregister = () => {
    if (!registered) return
    registered = false
    view.removeEventListener('beforeunload', onBeforeUnload)
  }
  textarea.addEventListener('focus', register)
  textarea.addEventListener('blur', unregister)
  if (textarea.ownerDocument.activeElement === textarea) register()
  return () => {
    textarea.removeEventListener('focus', register)
    textarea.removeEventListener('blur', unregister)
    unregister()
  }
}

/**
 * Copies `text` through the browser's copy command, which works without the Clipboard API
 * permission and on plain-HTTP origins; falls back to the Clipboard API.
 */
export function copyTerminalText(text: string, doc: Document = document): void {
  if (!text) return
  let copied = false
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    event.stopImmediatePropagation()
    copied = true
  }
  doc.addEventListener('copy', onCopy, true)
  try { doc.execCommand('copy') } catch {} finally { doc.removeEventListener('copy', onCopy, true) }
  if (!copied) void navigator.clipboard?.writeText(text).catch(() => {})
}

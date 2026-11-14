/**
 * Whether the WebUI runs in an app window rather than a browser tab: the Windows or macOS
 * Desktop host (it injects `window.foxwarmFrame`), or an installed PWA in standalone or
 * window-controls-overlay display. There, window.open of a same-origin page opens another
 * app window, and other pages open in the user's browser, so visible copy says
 * "new window" instead of "new browser tab".
 */
import { useSyncExternalStore } from 'react'
import { readHostFrame } from './windowFrame'

const APP_DISPLAY_QUERIES = ['(display-mode: standalone)', '(display-mode: window-controls-overlay)']

/** The Desktop host's frame state of the top-level document; same-origin frames such as Code's embedded WebUI read it there. */
function topHostFrame(): unknown {
  try { return window.top?.foxwarmFrame } catch { return undefined }
}

export function isAppWindow(): boolean {
  if (typeof window === 'undefined') return false
  if (readHostFrame(topHostFrame())) return true
  return APP_DISPLAY_QUERIES.some(query => window.matchMedia?.(query).matches ?? false)
}

/** Display-mode changes, e.g. Chrome's "Open in app" moving a tab into an app window. */
function subscribeAppWindow(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const lists = APP_DISPLAY_QUERIES.map(query => window.matchMedia?.(query)).filter((list): list is MediaQueryList => !!list)
  for (const list of lists) list.addEventListener('change', listener)
  window.addEventListener('foxwarm-frame', listener)
  return () => {
    for (const list of lists) list.removeEventListener('change', listener)
    window.removeEventListener('foxwarm-frame', listener)
  }
}

export function useAppWindow(): boolean {
  return useSyncExternalStore(subscribeAppWindow, isAppWindow, () => false)
}

export type NewWindowCopy = {
  /** Tooltip of the sidebar Code item when Code opens outside the workbench. */
  codeTooltip: string
  /** The Code option that opens Code outside the workbench. */
  codeOption: string
}

export function newWindowCopy(appWindow: boolean): NewWindowCopy {
  return appWindow
    ? { codeTooltip: 'Open code in a new window', codeOption: 'Open in new window' }
    : { codeTooltip: 'Open code in a new browser tab', codeOption: 'Open in new browser tab' }
}

/** Confirmation before a chat link opens: in an app window it names where the link goes. */
export function linkOpenConfirmation(href: string, appWindow: boolean, base: string): string {
  if (!appWindow) return `Open this link in a new tab?\n\n${href}`
  let sameOrigin = false
  try {
    const url = new URL(href, base)
    sameOrigin = url.origin === new URL(base).origin
  } catch {}
  return `${sameOrigin ? 'Open this link in a new window?' : 'Open this link in your browser?'}\n\n${href}`
}

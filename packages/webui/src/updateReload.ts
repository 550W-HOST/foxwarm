import { parseFoxwarmEmbeddedTarget } from './embeddedWebUi'
import { parseFoxwarmPopupTarget } from './popupWebUi'

export const BEFORE_UPDATE_RELOAD = 'foxwarm-before-update-reload'

/** Popouts and Code leaves do not own deployment checks or update banners. */
export function isStandaloneWebUi(): boolean {
  return window.self === window.top
    && !parseFoxwarmPopupTarget(location.search)
    && !parseFoxwarmEmbeddedTarget(location.search)
}

function prepareReload(target: Window): boolean {
  let ready = target.dispatchEvent(new Event(BEFORE_UPDATE_RELOAD, { cancelable: true }))
  // Reloading the workbench also destroys its Code/Chat descendants. Prepare
  // same-origin leaves without giving them their own poller or update banner.
  for (let index = 0; index < target.frames.length; index++) {
    const child = target.frames[index]
    try { void child.document } catch { continue } // Cross-origin editors retain native beforeunload protection.
    if (!prepareReload(child)) ready = false
  }
  return ready
}

/** Both startup recovery and live update actions use this preparation boundary.
 * Keep the normal browser beforeunload protections for other editors intact. */
export function requestUpdateReload(confirmEdits = true): boolean {
  if (!prepareReload(window)) return false
  if (!confirmEdits || window.confirm('Reload Foxwarm? Save any unsaved edits first.')) location.reload()
  return true
}

import { useSyncExternalStore } from 'react'

/** The WebUI's touch distinction: the primary pointer is a finger, not a mouse or trackpad. */
const COARSE_POINTER_QUERY = '(pointer: coarse)'

function subscribeCoarsePointer(notify: () => void) {
  const query = window.matchMedia?.(COARSE_POINTER_QUERY)
  if (!query) return () => {}
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

export function isPrimaryPointerCoarse() {
  return window.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false
}

export function usePrimaryPointerCoarse() {
  return useSyncExternalStore(subscribeCoarsePointer, isPrimaryPointerCoarse, () => false)
}

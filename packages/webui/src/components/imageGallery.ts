import { createContext, useLayoutEffect, useMemo, useRef } from 'react'

/**
 * One image the full-screen viewer can switch to. The source that renders the image
 * supplies its URL and MIME type and keeps their ownership; `download` replaces the
 * viewer's default signed image-blob download for sources with their own route.
 */
export type ImageGalleryEntry = {
  key: string
  src: string
  mimeType: string
  title: string
  download?: (signal: AbortSignal) => Promise<void>
}

/**
 * The images a viewer opened inside this scope switches between, in display order.
 * `keyOf` maps an opener's own identity (a message part object or a string key) to
 * its entry key; an opener that isn't in the list keeps a single-image viewer.
 */
export type ImageGallery = {
  entries(): readonly ImageGalleryEntry[]
  keyOf(item: unknown): string | undefined
  subscribe(listener: () => void): () => void
}

export const ImageGalleryContext = createContext<ImageGallery | null>(null)

const EMPTY: readonly ImageGalleryEntry[] = []

/**
 * A stable store for `ImageGalleryContext`: consumers subscribe only while a viewer is
 * open, so a changed list doesn't re-render every thumbnail. `keys` maps object
 * identities (message parts) to entry keys; string items are their own keys.
 */
export function useImageGalleryStore(entries: readonly ImageGalleryEntry[], keys?: WeakMap<object, string>): ImageGallery {
  const state = useRef({ entries: EMPTY, keys: undefined as WeakMap<object, string> | undefined, listeners: new Set<() => void>() })
  const store = useMemo<ImageGallery>(() => ({
    entries: () => state.current.entries,
    keyOf: item => typeof item === 'string' ? item : item && typeof item === 'object' ? state.current.keys?.get(item) : undefined,
    subscribe: listener => {
      state.current.listeners.add(listener)
      return () => { state.current.listeners.delete(listener) }
    },
  }), [])
  // Assigned during render so that a viewer mounted in the same commit sees the list.
  state.current.entries = entries
  state.current.keys = keys
  useLayoutEffect(() => {
    for (const listener of state.current.listeners) listener()
  }, [entries, keys])
  return store
}

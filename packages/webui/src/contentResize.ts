import { createContext, useContext, useLayoutEffect, type MutableRefObject } from 'react'

// A positioned content host calls its leaf before changing the viewport size.
// Independent popup/embedded leaves have no host and keep their normal observers.
export const ContentBeforeResizeContext = createContext<MutableRefObject<(() => void) | null> | null>(null)

export function useContentBeforeResize(callback: () => void) {
  const owner = useContext(ContentBeforeResizeContext)
  useLayoutEffect(() => {
    if (!owner) return
    owner.current = callback
    return () => { owner.current = null }
  }, [owner, callback])
}

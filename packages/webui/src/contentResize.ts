import { createContext, useContext, useLayoutEffect } from 'react'

// A positioned content host calls its leaf before changing the viewport size.
// Independent popup/embedded leaves have no host and keep their normal observers.
export interface ContentResizeOwner {
  beforeResize: (() => void) | null
  isLayoutReady: () => boolean
}
export const ContentBeforeResizeContext = createContext<ContentResizeOwner | null>(null)

const independentLayoutReady = () => true

export function useContentBeforeResize(callback: () => void) {
  const owner = useContext(ContentBeforeResizeContext)
  useLayoutEffect(() => {
    if (!owner) return
    owner.beforeResize = callback
    return () => { owner.beforeResize = null }
  }, [owner, callback])
  return owner?.isLayoutReady ?? independentLayoutReady
}

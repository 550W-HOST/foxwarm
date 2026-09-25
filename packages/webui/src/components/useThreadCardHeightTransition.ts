import { createContext, useCallback, useContext, useLayoutEffect, useRef, type RefObject } from 'react'

/** Chat owns viewport follow; cards only report the measured height change. */
export const ThreadCardHeightContext = createContext<{
  before: () => () => void
  begin: (card: HTMLElement, startHeight: number, targetHeight: number) => () => void
} | null>(null)

const DURATION_MS = 240

export function useThreadCardHeightTransition(expanded: boolean): {
  ref: RefObject<HTMLDivElement>
  prepare: () => void
} {
  const ref = useRef<HTMLDivElement>(null)
  const startRef = useRef<number | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const releaseBeforeRef = useRef<(() => void) | null>(null)
  const notifyChat = useContext(ThreadCardHeightContext)

  const prepare = useCallback(() => {
    const element = ref.current
    if (!element) return
    startRef.current = element.getBoundingClientRect().height
    releaseBeforeRef.current?.()
    releaseBeforeRef.current = notifyChat?.before() ?? null
  }, [notifyChat])

  useLayoutEffect(() => {
    const element = ref.current
    const start = startRef.current
    startRef.current = null
    if (!element || start === null) return
    const releaseBefore = releaseBeforeRef.current
    releaseBeforeRef.current = null

    // React has committed the new card contents, but the browser has not painted them.
    // Remove the prior target height before reading the new natural height (also handles reversal).
    const previousCancel = cancelRef.current
    previousCancel?.()
    // Clear any prior transition before measuring natural layout: changing an
    // animating pixel height straight to auto can otherwise report the old
    // interpolated height as the target during a rapid reversal.
    element.style.removeProperty('transition')
    element.style.removeProperty('height')
    const target = element.getBoundingClientRect().height
    cancelRef.current = null
    const releaseFollow = notifyChat?.begin(element, start, target)
    releaseBefore?.()
    if (Math.abs(target - start) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      releaseFollow?.()
      return
    }
    let frame = 0
    let fallback = 0
    let finished = false
    let started = false
    const finish = () => {
      if (finished) return
      finished = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
      element.removeEventListener('transitionend', onEnd)
      element.removeEventListener('transitioncancel', onEnd)
      element.style.removeProperty('height')
      element.style.removeProperty('transition')
      element.style.removeProperty('overflow')
      element.style.removeProperty('overflow-clip-margin')
      element.style.removeProperty('box-sizing')
      releaseFollow?.()
      cancelRef.current = null
    }
    const onEnd = (event: TransitionEvent) => {
      // A cancelled *previous* transition can dispatch after the new listener
      // is installed. It must not finish the new transition before it starts.
      if (started && event.target === element && event.propertyName === 'height') finish()
    }
    cancelRef.current = finish
    element.style.boxSizing = 'border-box'
    element.style.transition = 'none'
    element.style.height = `${start}px`
    // Clip overflowing body paint during interpolation while leaving 24px for the
    // disclosure gutter and nearby action controls outside the card bounds.
    element.style.overflow = 'clip'
    element.style.overflowClipMargin = '24px'
    void element.offsetHeight
    element.addEventListener('transitionend', onEnd)
    element.addEventListener('transitioncancel', onEnd)
    frame = window.requestAnimationFrame(() => {
      element.style.transition = `height ${DURATION_MS}ms ease-in-out`
      element.style.height = `${target}px`
      started = true
    })
    fallback = window.setTimeout(finish, DURATION_MS + 120)
  }, [expanded, notifyChat])

  useLayoutEffect(() => () => {
    cancelRef.current?.()
    releaseBeforeRef.current?.()
  }, [])

  return { ref, prepare }
}

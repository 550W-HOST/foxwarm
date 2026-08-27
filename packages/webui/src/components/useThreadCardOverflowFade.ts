import { type CSSProperties, type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react'

export type ThreadCardOverflowFadeAxis = 'right' | 'bottom'

type ThreadCardOverflowFade<T extends HTMLElement> = {
  ref: RefObject<T>
  overflowFadeProps: {
    'data-overflow-fade'?: ThreadCardOverflowFadeAxis
    style?: CSSProperties
  }
}

const fadeMask: Record<ThreadCardOverflowFadeAxis, string> = {
  right: 'linear-gradient(to right, #000 0, #000 calc(100% - 2rem), transparent 100%)',
  bottom: 'linear-gradient(to bottom, #000 0, #000 calc(100% - 1.6rem), transparent 100%)',
}

/** Measures one clipped thread-card surface and fades only when content actually overflows. */
export const useThreadCardOverflowFade = <T extends HTMLElement>(
  axis: ThreadCardOverflowFadeAxis,
  enabled = true,
): ThreadCardOverflowFade<T> => {
  const ref = useRef<T>(null)
  const [overflowed, setOverflowed] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !enabled) {
      setOverflowed(false)
      return
    }

    let frame: number | null = null
    const measure = () => {
      frame = null
      const next = axis === 'right'
        ? element.scrollWidth > element.clientWidth + 1
        : element.scrollHeight > element.clientHeight + 1
      setOverflowed(current => current === next ? current : next)
    }
    const scheduleMeasure = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure)
    }

    measure()
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(element)
    const mutationObserver = new MutationObserver(scheduleMeasure)
    mutationObserver.observe(element, { childList: true, characterData: true, subtree: true })

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [axis, enabled])

  const style = useMemo<CSSProperties | undefined>(() => overflowed ? {
    WebkitMaskImage: fadeMask[axis],
    maskImage: fadeMask[axis],
  } : undefined, [axis, overflowed])

  return {
    ref,
    overflowFadeProps: {
      ...(overflowed ? { 'data-overflow-fade': axis } : {}),
      ...(style ? { style } : {}),
    },
  }
}
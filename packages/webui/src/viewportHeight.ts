/**
 * App shell height. `--foxwarm-app-height` defaults to `100dvh`, which is exactly the
 * layout viewport the document is laid out in. The visual viewport differs from it only
 * while an on-screen keyboard or pinch zoom shrinks or shifts it; then the shell is
 * pinned to what is actually visible.
 *
 * `visualViewport.height` is fractional whenever the window's pixel size isn't a
 * multiple of the device scale (125 % display scaling, 110 % browser zoom). Rounding it
 * up made the shell up to half a CSS pixel taller than the layout viewport, which gave
 * the document a sub-pixel scroll range and a page-level scrollbar next to the shell.
 */

export type ViewportMetrics = {
  /** CSS px to pin the shell to, or `null` to keep the `100dvh` default. */
  height: number | null
  /** CSS px the visible area is shifted down from the layout viewport's top. */
  topOffset: number
}

/** Visual and layout viewports closer than this (CSS px) are the same viewport, differing only by rounding. */
const SAME_VIEWPORT_TOLERANCE = 1

export function appViewportMetrics(
  visual: { height: number; offsetTop: number } | null | undefined,
  layoutHeight: number,
): ViewportMetrics {
  if (!visual) return { height: null, topOffset: 0 }
  const same = Math.abs(visual.height - layoutHeight) < SAME_VIEWPORT_TOLERANCE && Math.abs(visual.offsetTop) < SAME_VIEWPORT_TOLERANCE
  return same ? { height: null, topOffset: 0 } : { height: Math.round(visual.height), topOffset: Math.round(visual.offsetTop) }
}

export function syncViewportHeight() {
  const style = document.documentElement.style
  const { height, topOffset } = appViewportMetrics(window.visualViewport, window.innerHeight)
  if (height === null) style.removeProperty('--foxwarm-app-height')
  else style.setProperty('--foxwarm-app-height', `${height}px`)
  style.setProperty('--foxwarm-app-top-offset', `${topOffset}px`)
}

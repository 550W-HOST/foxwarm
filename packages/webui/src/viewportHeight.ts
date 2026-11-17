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
 *
 * The root also carries the two facts index.css needs for the app shell's bottom
 * geometry: whether this is an installed iOS web app, whose short `100dvh` the at-rest
 * mobile shell extends to the screen bottom, and whether the shell is currently pinned
 * to the visual viewport, which ends that extension and the bottom safe band.
 */

export type ViewportMetrics = {
  /** CSS px to pin the shell to, or `null` to keep the at-rest CSS height. */
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

/** Installed iOS home-screen web app; ordinary Safari tabs and other platforms report no `navigator.standalone`. */
export function markIosStandaloneViewport() {
  document.documentElement.toggleAttribute('data-foxwarm-ios-standalone', 'standalone' in navigator && navigator.standalone === true)
}

export function syncViewportHeight() {
  const root = document.documentElement
  const { height, topOffset } = appViewportMetrics(window.visualViewport, window.innerHeight)
  if (height === null) root.style.removeProperty('--foxwarm-app-height')
  else root.style.setProperty('--foxwarm-app-height', `${height}px`)
  root.style.setProperty('--foxwarm-app-top-offset', `${topOffset}px`)
  root.toggleAttribute('data-foxwarm-viewport-pinned', height !== null)
}

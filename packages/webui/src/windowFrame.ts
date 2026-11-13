/**
 * Custom window frame for the Desktop hosts and installed PWAs in window-controls overlay.
 *
 * Providers:
 * - The Windows and macOS Desktop hosts inject `window.foxwarmFrame` at document
 *   creation and replace it, dispatching a `foxwarm-frame` event, when the control
 *   insets or the window state change.
 * - An installed Chromium PWA in window-controls-overlay mode. index.css derives the
 *   insets from env(titlebar-area-*).
 * Without a provider this module installs nothing beyond two listeners, so ordinary
 * browsers, Safari, Firefox and mobile PWAs render exactly as before.
 *
 * Layout reads `html[data-foxwarm-frame]` and `--foxwarm-frame-left|right|top`. This
 * module adds what CSS can't express: per-row avoidance of the control zones
 * (`data-frame-row`), fills that extend title-row drag surfaces through the shell
 * gutter and panel padding to the window edges, the narrow-layout strip, and for the
 * Desktop hosts the `frame-regions` report, because neither WinUI's WebView2 control
 * nor WKWebView honours app-region.
 */

/** Host-provided frame state. Insets are CSS px and already account for full screen. */
export type HostFrameState = {
  platform: 'windows' | 'macos'
  left: number
  right: number
  top: number
  /** Window state tokens such as `inactive`, `maximized` or `fullscreen`. */
  state?: string[]
}

declare global {
  interface Window { foxwarmFrame?: HostFrameState }
}

export type FrameRect = { x: number; y: number; w: number; h: number }
/** Control zones: `left` and `right` are widths at the window's top corners, `top` their height. */
export type FrameZones = { left: number; right: number; top: number; width: number }
type BoxLike = { left: number; top: number; right: number; bottom: number }

/** Empty draggable width kept between the window controls and header content. */
export const FRAME_DRAG_GAP = 40
/** Thickest window chrome (shell gutter, panel border and padding) a drag surface extends through. */
export const FRAME_EDGE_REACH = 24
/** Rectangles per `frame-regions` report. */
export const FRAME_REGION_LIMIT = 128

import { refreshFrameChromeColor, setFrameChromeColor } from './theme/browserChrome'

const OVERLAY_QUERY = '(display-mode: window-controls-overlay)'
const NARROW_QUERY = '(max-width: 767px)'
const HOST_PLATFORMS = new Set(['windows', 'macos'])

/** Elements that keep their own clicks inside a drag surface. */
export const FRAME_INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, iframe, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="option"], [tabindex]:not([tabindex="-1"]), [data-tab-id], [data-frame-no-drag]'
/** Floating layers that may cover a drag surface; they always keep their clicks. */
export const FRAME_FLOATING = '[role="menu"], [role="dialog"], [role="listbox"], [role="tooltip"], [aria-modal="true"], [data-frame-no-drag]'
const FILL_CLASS = 'foxwarm-frame-fill'

export function readHostFrame(value: unknown = typeof window === 'undefined' ? undefined : window.foxwarmFrame): HostFrameState | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Partial<HostFrameState>
  if (typeof frame.platform !== 'string' || !HOST_PLATFORMS.has(frame.platform)) return null
  const inset = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0
  const state = Array.isArray(frame.state) ? frame.state.filter((token): token is string => typeof token === 'string' && /^[a-z-]+$/.test(token)) : []
  return { platform: frame.platform, left: inset(frame.left), right: inset(frame.right), top: inset(frame.top), state }
}

export function subtractRect(base: FrameRect, hole: FrameRect): FrameRect[] {
  const x1 = Math.max(base.x, hole.x), y1 = Math.max(base.y, hole.y)
  const x2 = Math.min(base.x + base.w, hole.x + hole.w), y2 = Math.min(base.y + base.h, hole.y + hole.h)
  if (x1 >= x2 || y1 >= y2) return [base]
  const out: FrameRect[] = []
  if (y1 > base.y) out.push({ x: base.x, y: base.y, w: base.w, h: y1 - base.y })
  if (y2 < base.y + base.h) out.push({ x: base.x, y: y2, w: base.w, h: base.y + base.h - y2 })
  if (x1 > base.x) out.push({ x: base.x, y: y1, w: x1 - base.x, h: y2 - y1 })
  if (x2 < base.x + base.w) out.push({ x: x2, y: y1, w: base.x + base.w - x2, h: y2 - y1 })
  return out
}

/**
 * How a frame row clears the control zones. A row is in the band when it starts above
 * the zones' bottom edge. Stack rows (sidebar, rail) move their content below the
 * controls; inline rows (tab strip, sole-tab header) reserve the overlap plus a drag gap.
 */
export function frameRowLayout(row: BoxLike, zones: FrameZones, kind: 'stack' | 'inline') {
  const inBand = row.top < zones.top && row.bottom > 0
  const hitsLeft = inBand && zones.left > 0 && row.left < zones.left
  const hitsRight = inBand && zones.right > 0 && row.right > zones.width - zones.right
  if (kind === 'stack') return { inBand, top: hitsLeft || hitsRight ? Math.max(0, Math.ceil(zones.top - row.top)) : 0, left: 0, right: 0 }
  return {
    inBand,
    top: 0,
    left: hitsLeft ? Math.ceil(zones.left - row.left) + FRAME_DRAG_GAP : 0,
    right: hitsRight ? Math.ceil(row.right - (zones.width - zones.right)) + FRAME_DRAG_GAP : 0,
  }
}

/**
 * Window chrome between a drag surface and the window edges it nearly touches, as
 * groups of alternatives: the first alternative that holds only chrome is used. The
 * top fill takes the corners too when the surface also reaches a side edge.
 */
export function frameEdgeFillCandidates(surface: FrameRect, width: number, reach = FRAME_EDGE_REACH): FrameRect[][] {
  const right = surface.x + surface.w
  const near = (gap: number) => gap > 0.5 && gap <= reach
  const up = near(surface.y), toLeft = near(surface.x), toRight = near(width - right)
  const groups: FrameRect[][] = []
  if (up) {
    const narrow = { x: surface.x, y: 0, w: surface.w, h: surface.y }
    const x1 = toLeft ? 0 : surface.x, x2 = toRight ? width : right
    groups.push(x1 === surface.x && x2 === right ? [narrow] : [{ x: x1, y: 0, w: x2 - x1, h: surface.y }, narrow])
  }
  if (toLeft) groups.push([{ x: 0, y: surface.y, w: surface.x, h: surface.h }])
  if (toRight) groups.push([{ x: right, y: surface.y, w: width - right, h: surface.h }])
  return groups
}

const toRect = (r: DOMRect): FrameRect => ({ x: r.left, y: r.top, w: r.width, h: r.height })

/** Drag surfaces that are currently active: in a title-band row, or outside any row. */
function activeDragSurfaces(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-frame-drag]')].filter(drag => {
    const row = drag.closest('[data-frame-row]')
    return !row || row.hasAttribute('data-frame-in-band')
  })
}

/**
 * Drag rectangles in CSS px relative to the viewport: active drag surfaces minus their
 * interactive descendants and minus every floating layer.
 */
export function collectFrameDragRects(doc: Document = document): number[][] {
  const floating = [...doc.querySelectorAll(FRAME_FLOATING)].map(el => toRect(el.getBoundingClientRect()))
  const rects: FrameRect[] = []
  for (const drag of activeDragSurfaces(doc)) {
    const box = drag.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    let parts = [toRect(box)]
    const own = [...drag.querySelectorAll(FRAME_INTERACTIVE)].map(el => toRect(el.getBoundingClientRect()))
    for (const hole of [...own, ...floating]) parts = parts.flatMap(part => subtractRect(part, hole))
    rects.push(...parts)
  }
  return rects
    .filter(r => r.w >= 2 && r.h >= 2)
    .slice(0, FRAME_REGION_LIMIT)
    .map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)])
}

const hasOwnText = (element: Element) => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim())

/**
 * Whether a point shows only window chrome for `surface`: its own containers, another
 * blank drag surface, or a plain container (no text, media or interactive role).
 * Floating layers and fills are looked through; they never decide the shape.
 */
function isChromePoint(doc: Document, surface: Element, x: number, y: number): boolean {
  for (const hit of doc.elementsFromPoint(x, y)) {
    if (hit.classList.contains(FILL_CLASS) || hit.closest(FRAME_FLOATING)) continue
    if (hit.contains(surface)) return true
    if (hit.closest(FRAME_INTERACTIVE)) return false
    if (hit.matches('[data-frame-drag]')) return true
    return !hasOwnText(hit) && !(hit instanceof SVGElement) && !hit.matches('img, canvas, video, picture')
  }
  return true
}

function holdsOnlyChrome(doc: Document, surface: Element, piece: FrameRect): boolean {
  // Hit testing works on whole pixels: sample every pixel row and column the piece covers, 6 px apart, plus its last ones.
  const samples = (start: number, size: number) => {
    const first = Math.ceil(start), last = Math.floor(start + size - 0.01)
    const out: number[] = []
    for (let v = first; v < last; v += 6) out.push(v)
    if (last >= first) out.push(last)
    return out
  }
  const xs = samples(piece.x, piece.w), ys = samples(piece.y, piece.h)
  if (!xs.length || !ys.length) return false
  return ys.every(y => xs.every(x => isChromePoint(doc, surface, x, y)))
}

/** Fills that extend every active drag surface to the window edges it nearly touches. */
export function computeFrameEdgeFills(doc: Document = document): FrameRect[] {
  const width = doc.documentElement.clientWidth
  const fills: FrameRect[] = []
  for (const surface of activeDragSurfaces(doc)) {
    if (surface.classList.contains(FILL_CLASS)) continue
    const box = surface.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    for (const group of frameEdgeFillCandidates(toRect(box), width)) {
      const piece = group.find(candidate => holdsOnlyChrome(doc, surface, candidate))
      if (piece) fills.push(piece)
    }
  }
  return fills
}

type HostChannel = { postMessage(message: unknown): void }

type Rgba = [number, number, number, number]

function parseColor(value: string): Rgba | null {
  const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])]
  // color-mix() and relative colours compute to color(srgb r g b / a) with 0..1 channels.
  const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
  return null
}

/**
 * Opaque colour of the surface the window controls sit on, as #rrggbb: the topmost page
 * element under the middle of the larger control zone, composited over its ancestors'
 * backgrounds. Null without a control zone or an opaque background.
 */
export function frameSurfaceColor(doc: Document, zones: FrameZones): string | null {
  if (!zones.top || (!zones.left && !zones.right)) return null
  const x = zones.left >= zones.right ? zones.left / 2 : zones.width - zones.right / 2
  const target = doc.elementsFromPoint(x, zones.top / 2).find(element => !element.closest('.foxwarm-frame-fills'))
  const layers: Rgba[] = []
  for (let element: Element | null = target ?? null; element; element = element.parentElement) {
    const color = parseColor(getComputedStyle(element).backgroundColor)
    if (!color || color[3] === 0) continue
    layers.push(color)
    if (color[3] >= 1) break
  }
  if (!layers.length || layers[layers.length - 1][3] < 1) return null
  let [r, g, b] = layers.pop()!
  for (const [lr, lg, lb, la] of layers.reverse()) {
    r = lr * la + r * (1 - la)
    g = lg * la + g * (1 - la)
    b = lb * la + b * (1 - la)
  }
  return '#' + [r, g, b].map(channel => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')
}

/** Page-to-host channel; present only inside a Desktop host's top-level document. */
function hostChannel(): HostChannel | undefined {
  const w = window as Window & {
    chrome?: { webview?: HostChannel }
    webkit?: { messageHandlers?: Record<string, HostChannel> }
  }
  return w.chrome?.webview ?? w.webkit?.messageHandlers?.foxwarmFrame
}

export function initializeWindowFrame(): void {
  if (typeof window === 'undefined' || window.parent !== window) return
  const root = document.documentElement
  const overlay = window.matchMedia?.(OVERLAY_QUERY) ?? null
  let runtime: FrameRuntime | null = null

  const sync = () => {
    const host = readHostFrame()
    if (host) {
      root.dataset.foxwarmFrame = host.platform
      root.style.setProperty('--foxwarm-frame-left', `${host.left}px`)
      root.style.setProperty('--foxwarm-frame-right', `${host.right}px`)
      root.style.setProperty('--foxwarm-frame-top', `${host.top}px`)
      if (host.state?.length) root.dataset.foxwarmWindow = host.state.join(' ')
      else delete root.dataset.foxwarmWindow
    } else if (overlay?.matches) {
      root.dataset.foxwarmFrame = 'overlay'
    } else {
      delete root.dataset.foxwarmFrame
    }
    if (root.dataset.foxwarmFrame && !runtime) runtime = startFrameRuntime(root, !!host)
    else if (!root.dataset.foxwarmFrame && runtime) { runtime.stop(); runtime = null }
    else runtime?.relayout()
  }

  window.addEventListener('foxwarm-frame', sync)
  overlay?.addEventListener('change', sync)
  sync()
}

type FrameRuntime = { relayout(): void; stop(): void }

function startFrameRuntime(root: HTMLElement, hosted: boolean): FrameRuntime {
  const narrow = window.matchMedia?.(NARROW_QUERY) ?? null
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  // Resolves the inset variables, including env() under the PWA overlay, to px.
  probe.style.cssText = 'box-sizing:content-box;position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:var(--foxwarm-frame-left,0px);height:var(--foxwarm-frame-top,0px);border-right:solid 0 transparent;border-right-width:var(--foxwarm-frame-right,0px)'
  document.body.appendChild(probe)
  // Fills come first in the document so that later no-drag layers win under app-region,
  // and paint beneath the shell, which already shows the chrome they cover.
  const fills = document.createElement('div')
  fills.setAttribute('aria-hidden', 'true')
  fills.className = 'foxwarm-frame-fills'
  document.body.prepend(fills)
  let strip: HTMLDivElement | null = null
  let frame = 0
  let layoutDirty = true
  let lastReport = ''

  const readZones = (): FrameZones => {
    const style = getComputedStyle(probe)
    return {
      left: parseFloat(style.width) || 0,
      right: parseFloat(style.borderRightWidth) || 0,
      top: parseFloat(style.height) || 0,
      width: root.clientWidth,
    }
  }

  const clearRow = (element: HTMLElement) => {
    element.style.removeProperty('--foxwarm-frame-pad-left')
    element.style.removeProperty('--foxwarm-frame-pad-right')
    element.style.removeProperty('--foxwarm-frame-pad-top')
    element.removeAttribute('data-frame-in-band')
  }

  let lastFills = ''
  const renderFills = (pieces: FrameRect[]) => {
    const key = JSON.stringify(pieces)
    if (key === lastFills) return
    lastFills = key
    fills.replaceChildren(...pieces.map(piece => {
      const element = document.createElement('div')
      element.className = FILL_CLASS
      element.setAttribute('data-frame-drag', '')
      element.style.cssText = `left:${piece.x}px;top:${piece.y}px;width:${piece.w}px;height:${piece.h}px`
      return element
    }))
  }

  const layout = () => {
    const zones = readZones()
    const isNarrow = !!narrow?.matches
    root.toggleAttribute('data-foxwarm-frame-narrow', isNarrow)
    if (isNarrow && !strip) {
      strip = document.createElement('div')
      strip.className = 'foxwarm-frame-strip'
      strip.setAttribute('data-frame-drag', '')
      strip.setAttribute('aria-hidden', 'true')
      document.body.appendChild(strip)
    } else if (!isNarrow && strip) {
      strip.remove()
      strip = null
    }
    const rows = [...document.querySelectorAll<HTMLElement>('[data-frame-row]')]
    if (isNarrow) {
      rows.forEach(clearRow)
      renderFills([])
      return
    }
    // Read every row before writing so that one pass needs one layout.
    const plans = rows.map(element => ({ element, plan: frameRowLayout(element.getBoundingClientRect(), zones, element.dataset.frameRow === 'stack' ? 'stack' : 'inline') }))
    for (const { element, plan } of plans) {
      element.toggleAttribute('data-frame-in-band', plan.inBand)
      element.style.setProperty('--foxwarm-frame-pad-top', `${plan.top}px`)
      element.style.setProperty('--foxwarm-frame-pad-left', `${plan.left}px`)
      element.style.setProperty('--foxwarm-frame-pad-right', `${plan.right}px`)
    }
    renderFills(computeFrameEdgeFills(document))
  }

  const report = () => {
    const channel = hostChannel()
    if (!channel) return
    const regions = collectFrameDragRects(document)
    // Caption buttons (Windows) and the window appearance (macOS) follow the page theme.
    const colorScheme = root.classList.contains('dark') ? 'dark' : 'light'
    const key = JSON.stringify([regions, colorScheme])
    if (key === lastReport) return
    lastReport = key
    channel.postMessage({ type: 'frame-regions', regions, colorScheme })
  }

  const overlay = root.dataset.foxwarmFrame === 'overlay'
  // The theme runtime re-reads this on every theme change; layout changes refresh it below.
  if (overlay) setFrameChromeColor(() => frameSurfaceColor(document, readZones()))

  const run = () => {
    frame = 0
    if (layoutDirty) {
      layoutDirty = false
      layout()
      if (overlay) refreshFrameChromeColor()
    }
    if (hosted) report()
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(run) }
  const relayout = () => { layoutDirty = true; schedule() }

  const resize = new ResizeObserver(relayout)
  resize.observe(root)
  const observed = new WeakSet<Element>()
  const observeRows = () => {
    for (const element of document.querySelectorAll('[data-frame-row]')) {
      if (observed.has(element)) continue
      observed.add(element)
      resize.observe(element)
    }
  }
  // Rows appear and disappear with sidebar collapse, pane splits and tab changes.
  const touchesRow = (node: Node) => node instanceof Element && (node.matches('[data-frame-row]') || !!node.querySelector('[data-frame-row]'))
  const rowObserver = new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes, ...record.removedNodes].some(touchesRow))) return
    observeRows()
    relayout()
  })
  rowObserver.observe(document.body, { childList: true, subtree: true })
  // Menus, dialogs, tab changes and theme changes alter the reported regions.
  const reportObserver = hosted && hostChannel() ? new MutationObserver(schedule) : null
  reportObserver?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-frame-in-band'] })
  reportObserver?.observe(root, { attributes: true, attributeFilter: ['class'] })
  narrow?.addEventListener('change', relayout)
  const overlayGeometry = (navigator as Navigator & { windowControlsOverlay?: EventTarget }).windowControlsOverlay
  overlayGeometry?.addEventListener('geometrychange', relayout)
  observeRows()
  relayout()

  return {
    relayout,
    stop() {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      rowObserver.disconnect()
      reportObserver?.disconnect()
      narrow?.removeEventListener('change', relayout)
      overlayGeometry?.removeEventListener('geometrychange', relayout)
      document.querySelectorAll<HTMLElement>('[data-frame-row]').forEach(clearRow)
      if (overlay) setFrameChromeColor(null)
      root.removeAttribute('data-foxwarm-frame-narrow')
      probe.remove()
      fills.remove()
      strip?.remove()
    },
  }
}

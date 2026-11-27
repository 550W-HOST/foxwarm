import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { requestImageDownloadUrl, triggerBrowserDownload } from './downloadShared'
import { ImageGalleryContext, type ImageGalleryEntry } from './imageGallery'

const raster = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const isSafeImagePreviewMime = (mimeType: unknown) => typeof mimeType === 'string' && raster.has(mimeType.toLowerCase())

let scrollLocks = 0
let savedOverflow = { root: '', body: '' }
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    savedOverflow = { root: document.documentElement.style.overflow, body: document.body.style.overflow }
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
  }
  return () => {
    if (--scrollLocks === 0) {
      document.documentElement.style.overflow = savedOverflow.root
      document.body.style.overflow = savedOverflow.body
    }
  }
}

interface Props {
  src: string
  mimeType: string
  title: string
  onClose: () => void
  onDownload?: () => void
  downloadPending?: boolean
  downloadError?: string
  /**
   * The opener's identity in the surrounding `ImageGalleryContext` (a message part or a
   * string key). When it is found the viewer switches among the gallery's images; the
   * opener's own image keeps the props above, including its download state.
   */
  galleryItem?: unknown
}

type OwnDownload = Pick<Props, 'onDownload' | 'downloadPending' | 'downloadError'>
type Step = -1 | 1

/** Movement after which a pointer press is a drag or swipe, not a click. */
const DRAG_THRESHOLD = 6
/** Horizontal travel, and dominance over vertical travel, of a touch swipe that switches images. */
const SWIPE_DISTANCE = 48
const SWIPE_DOMINANCE = 1.5
/** Wheel zoom: CSS px of wheel travel per e-fold, and the largest step one event may take. */
const WHEEL_ZOOM_RATE = 0.01
const WHEEL_ZOOM_STEP = 30
/** Wheel events this close together, at the same pointer, continue one zoom around one image point. */
const WHEEL_ANCHOR_MS = 400

const noSubscribe = () => () => {}
const NO_ENTRIES: readonly ImageGalleryEntry[] = []
const noEntries = () => NO_ENTRIES
const OWN_KEY = '\u0000own'

function Preview({ image, own, index, count, titleId, onNavigate, onClose }: {
  image: ImageGalleryEntry
  own?: OwnDownload
  index: number
  count: number
  titleId: string
  onNavigate: (step: Step) => void
  onClose: () => void
}) {
  const { src, mimeType, title } = image
  const bodyRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number; startX: number; startY: number }>())
  const pinch = useRef<{ distance: number; scale: number; x: number; y: number } | null>(null)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null)
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const suppressClick = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const [failed, setFailed] = useState(!isSafeImagePreviewMime(mimeType))
  const [loaded, setLoaded] = useState(false)
  const [{ scale, actualSize }, setView] = useState({ scale: 1, actualSize: false })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [bounds, setBounds] = useState({ width: 0, height: 0, left: 0, top: 0 })
  const [dragging, setDragging] = useState(false)
  const fit = natural.width && bounds.width ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height) : 1
  const maxScale = Math.max(8 * fit, 1)
  const imageWidth = natural.width * (actualSize ? scale : fit)
  const imageHeight = natural.height * (actualSize ? scale : fit)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  // Native wheel and gesture listeners read the rendered view, not a stale closure.
  const live = useRef({ scale, actualSize, fit, maxScale, loaded, failed })
  live.current = { scale, actualSize, fit, maxScale, loaded, failed }
  useLayoutEffect(() => {
    const stage = stageRef.current!
    const measure = () => {
      const style = getComputedStyle(stage)
      const left = parseFloat(style.paddingLeft), top = parseFloat(style.paddingTop)
      setBounds({ width: stage.clientWidth - left - parseFloat(style.paddingRight), height: stage.clientHeight - top - parseFloat(style.paddingBottom), left, top })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const stage = stageRef.current!
    const point = anchor.current
    if (point) {
      const box = stage.getBoundingClientRect()
      stage.scrollLeft = box.left + bounds.left + Math.max(0, (bounds.width - imageWidth) / 2) + point.x * imageWidth - point.clientX
      stage.scrollTop = box.top + bounds.top + Math.max(0, (bounds.height - imageHeight) / 2) + point.y * imageHeight - point.clientY
      anchor.current = null
    } else if (!actualSize) {
      stage.scrollTo(0, 0)
    }
  })
  useEffect(() => () => requestRef.current?.abort(), [])
  const imagePoint = (clientX: number, clientY: number) => {
    const box = imageRef.current!.getBoundingClientRect()
    return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height, clientX, clientY }
  }
  const toggleSize = () => {
    const stage = stageRef.current!
    const box = stage.getBoundingClientRect()
    anchor.current = actualSize ? null : imagePoint(box.left + stage.clientWidth / 2, box.top + stage.clientHeight / 2)
    setView({ scale: 1, actualSize: !actualSize })
  }
  /** Zooms to `next` (clamped to fit … max) keeping the image point under the client point still. */
  const zoomTo = useCallback((next: number, point: { x: number; y: number; clientX: number; clientY: number }) => {
    const view = live.current
    const target = Math.min(view.maxScale, Math.max(view.fit, next))
    if (target === (view.actualSize ? view.scale : view.fit)) return
    anchor.current = point
    // Synchronous, so the next event of the same gesture measures the image it produced.
    flushSync(() => setView({ scale: target, actualSize: target > view.fit }))
  }, [])
  useEffect(() => {
    const body = bodyRef.current!
    const ready = () => live.current.loaded && !live.current.failed && !!imageRef.current
    const current = () => live.current.actualSize ? live.current.scale : live.current.fit
    // Ctrl/⌘ + wheel, and Chromium's trackpad pinch, which arrives as ctrl + wheel. A plain wheel scrolls natively.
    // Successive events at the same pointer keep the image point they started with, rather than
    // re-measuring it from browser-rounded scroll offsets, so the point doesn't drift.
    let wheelAnchor: { x: number; y: number; clientX: number; clientY: number; time: number } | null = null
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (!ready() || pointers.current.size) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1
      const delta = Math.max(-WHEEL_ZOOM_STEP, Math.min(WHEEL_ZOOM_STEP, event.deltaY * unit))
      const previous = wheelAnchor
      const point = previous && event.timeStamp - previous.time < WHEEL_ANCHOR_MS && Math.abs(previous.clientX - event.clientX) < 1 && Math.abs(previous.clientY - event.clientY) < 1
        ? previous : imagePoint(event.clientX, event.clientY)
      wheelAnchor = { ...point, time: event.timeStamp }
      zoomTo(current() * Math.exp(-delta * WHEEL_ZOOM_RATE), { x: point.x, y: point.y, clientX: point.clientX, clientY: point.clientY })
    }
    // WebKit (Safari, the macOS Desktop host) reports trackpad pinch as gesture events with a
    // cumulative scale. Touch pinch on iOS also sends them, but pointer events own that gesture.
    type Gesture = UIEvent & { scale?: number; clientX?: number; clientY?: number }
    let gesture: { scale: number; x: number; y: number } | null = null
    const gesturePoint = (event: Gesture) => {
      const box = stageRef.current!.getBoundingClientRect()
      return { clientX: typeof event.clientX === 'number' ? event.clientX : box.left + box.width / 2, clientY: typeof event.clientY === 'number' ? event.clientY : box.top + box.height / 2 }
    }
    const gestureStart = (event: Event) => {
      event.preventDefault()
      gesture = null
      if (!ready() || pointers.current.size) return
      const { clientX, clientY } = gesturePoint(event as Gesture)
      const point = imagePoint(clientX, clientY)
      gesture = { scale: current(), x: point.x, y: point.y }
    }
    const gestureChange = (event: Event) => {
      event.preventDefault()
      const scaleFactor = (event as Gesture).scale
      if (!gesture || pointers.current.size || typeof scaleFactor !== 'number' || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return
      const { clientX, clientY } = gesturePoint(event as Gesture)
      zoomTo(gesture.scale * scaleFactor, { x: gesture.x, y: gesture.y, clientX, clientY })
    }
    const gestureEnd = (event: Event) => { event.preventDefault(); gesture = null }
    body.addEventListener('wheel', wheel, { passive: false })
    body.addEventListener('gesturestart', gestureStart)
    body.addEventListener('gesturechange', gestureChange)
    body.addEventListener('gestureend', gestureEnd)
    return () => {
      body.removeEventListener('wheel', wheel)
      body.removeEventListener('gesturestart', gestureStart)
      body.removeEventListener('gesturechange', gestureChange)
      body.removeEventListener('gestureend', gestureEnd)
    }
  }, [zoomTo])
  const resetGesture = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a || !b) {
      pinch.current = null
      const stage = stageRef.current!
      pan.current = a ? { x: a.x, y: a.y, left: stage.scrollLeft, top: stage.scrollTop } : null
      return
    }
    pan.current = null
    swipe.current = null
    const point = imagePoint((a.x + b.x) / 2, (a.y + b.y) / 2)
    pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: actualSize ? scale : fit, x: point.x, y: point.y }
    suppressClick.current = true
  }
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.size) suppressClick.current = false
    if (!loaded || failed) return
    // Touch pinches, pans and swipes; the mouse's primary button pans an enlarged image.
    const mouse = event.pointerType === 'mouse'
    if (mouse ? event.button !== 0 || !actualSize || pointers.current.size : event.pointerType !== 'touch') return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY })
    swipe.current = !mouse && pointers.current.size === 1 && !actualSize ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null
    // Capture on the original target so an ordinary tap or click still clicks the image.
    const target = event.target as HTMLElement
    target.setPointerCapture(event.pointerId)
    resetGesture()
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    event.preventDefault()
    pointers.current.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY })
    if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > DRAG_THRESHOLD) suppressClick.current = true
    if (pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const nextScale = Math.min(maxScale, Math.max(fit, pinch.current.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance))
      anchor.current = { x: pinch.current.x, y: pinch.current.y, clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }
      setView({ scale: nextScale, actualSize: nextScale > fit })
    } else if (actualSize && suppressClick.current && pan.current) {
      const stage = stageRef.current!
      // Keep fractional CSS-pixel intent, rather than adding each delta to a
      // browser-rounded scroll offset. Image zoom does not scale pointer motion.
      const drag = pan.current
      drag.left = Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, drag.left + drag.x - event.clientX))
      drag.top = Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, drag.top + drag.y - event.clientY))
      drag.x = event.clientX
      drag.y = event.clientY
      stage.scrollTo(drag.left, drag.top)
      if (event.pointerType === 'mouse' && !dragging) setDragging(true)
    }
  }
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    if (event.type !== 'pointerup') suppressClick.current = true
    const flick = swipe.current
    swipe.current = null
    if (dragging) setDragging(false)
    resetGesture()
    // A horizontal swipe at fit switches images; pinch and enlarged pans never do.
    if (event.type === 'pointerup' && flick?.id === event.pointerId && !actualSize) {
      const dx = event.clientX - flick.x, dy = event.clientY - flick.y
      if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > SWIPE_DOMINANCE * Math.abs(dy)) onNavigate(dx < 0 ? 1 : -1)
    }
  }
  const download = async () => {
    if (own?.onDownload) { own.onDownload(); return }
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    setPending(true); setError('')
    try {
      if (image.download) await image.download(controller.signal)
      else {
        const downloadUrl = /^(?:blob:|data:)/i.test(src) ? src : await requestImageDownloadUrl(src, title, controller.signal)
        if (!controller.signal.aborted) triggerBrowserDownload(downloadUrl, title)
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : ''
      if (!controller.signal.aborted) setError(message === 'Image unavailable' || message === 'File unavailable' ? message : 'Download unavailable')
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }
  const alert = own?.onDownload ? own.downloadError : error
  const multiple = count > 1
  return <>
    <header className="image-preview-header" data-frame-row="column" data-frame-drag>
      <h2 id={titleId} title={title}>{title}</h2>
      {multiple && <span className="image-preview-position" data-image-preview-position>{index + 1} / {count}</span>}
      <button type="button" className="image-preview-action" data-preview-control="size" disabled={failed || !loaded} aria-label={actualSize ? 'Fit image' : 'Actual size'} aria-pressed={actualSize} title={actualSize ? 'Fit image' : 'Actual size'} onClick={toggleSize}>{actualSize ? <ZoomOut size={20} /> : <ZoomIn size={20} />}</button>
      <button type="button" className="image-preview-action" data-preview-control="download" disabled={own?.onDownload ? own.downloadPending : pending} aria-label={`Download ${title}`} title="Download" onClick={() => { void download() }}><Download size={20} /></button>
      <button type="button" className="image-preview-action" data-preview-control="close" aria-label="Close image preview" title="Close" onClick={onClose}><X size={22} /></button>
    </header>
    <div ref={bodyRef} className="image-preview-body">
      <div ref={stageRef} className="image-preview-stage" data-actual-size={actualSize || undefined} data-dragging={dragging || undefined} tabIndex={0} aria-label="Image preview"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
        onContextMenu={event => {
          // Long-press belongs to touch pan/pinch. Mouse/keyboard context menus
          // must keep the browser's image Copy/Save actions available.
          const pointerType = (event.nativeEvent as PointerEvent).pointerType
          if (pointerType === 'touch' || !pointerType && pointers.current.size > 0) event.preventDefault()
        }}
        onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation() } }}
        onClick={event => { if (!actualSize && (event.target === event.currentTarget || event.target === surfaceRef.current)) onClose() }}>
        {failed ? <span role="status">Image unavailable</span> : <>
          {!loaded && <span role="status" className="image-preview-loading">Loading image…</span>}
          <div ref={surfaceRef} className="image-preview-surface" style={{ width: Math.max(bounds.width, imageWidth), height: Math.max(bounds.height, imageHeight) }}>
            <img ref={imageRef} src={src} alt={title} draggable={false} style={{ width: imageWidth, height: imageHeight }} onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true) }} onError={() => { setFailed(true); setLoaded(false) }} onClick={() => { toggleSize(); stageRef.current?.focus({ preventScroll: true }) }} />
          </div>
        </>}
      </div>
      {multiple && <>
        <button type="button" className="image-preview-nav" data-preview-control="previous" data-direction="previous" disabled={index <= 0} aria-label="Previous image" title="Previous image" onClick={() => onNavigate(-1)}><ChevronLeft size={24} /></button>
        <button type="button" className="image-preview-nav" data-preview-control="next" data-direction="next" disabled={index >= count - 1} aria-label="Next image" title="Next image" onClick={() => onNavigate(1)}><ChevronRight size={24} /></button>
      </>}
    </div>
    {alert && <div role="alert" className="image-preview-error">{alert}</div>}
  </>
}

const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

export default function ImagePreviewDialog({ src, mimeType, title, onClose, onDownload, downloadPending, downloadError, galleryItem }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const gallery = useContext(ImageGalleryContext)
  const entries = useSyncExternalStore(gallery?.subscribe ?? noSubscribe, gallery?.entries ?? noEntries, gallery?.entries ?? noEntries)
  const ownKey = galleryItem !== undefined ? gallery?.keyOf(galleryItem) : undefined
  // The opener's own image always uses its own props: URL, MIME type and download state.
  const ownImage = useMemo<ImageGalleryEntry>(() => ({ key: OWN_KEY, src, mimeType, title }), [src, mimeType, title])
  const ownIndex = ownKey === undefined ? -1 : entries.findIndex(entry => entry.key === ownKey)
  const sequence = useMemo(() => ownIndex < 0 ? [ownImage] : entries.map((entry, index) => index === ownIndex ? ownImage : entry), [entries, ownImage, ownIndex])
  const [currentKey, setCurrentKey] = useState(OWN_KEY)
  const lastShown = useRef(ownImage)
  const found = sequence.findIndex(entry => entry.key === currentKey)
  // An entry that leaves the gallery while shown stays on screen, alone.
  const current = found >= 0 ? sequence[found] : currentKey === OWN_KEY ? ownImage : lastShown.current
  const index = found >= 0 ? found : 0
  const count = found >= 0 ? sequence.length : 1
  lastShown.current = current
  const refocus = useRef<string | null>(null)
  const navigate = useCallback((step: Step) => {
    const next = sequence[index + step]
    if (found < 0 || !next) return
    const control = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-preview-control]')?.dataset.previewControl : undefined
    refocus.current = control ?? 'stage'
    setCurrentKey(next.key)
  }, [found, index, sequence])
  // The switched-to image remounts its view; focus returns to the same control, or the stage.
  useLayoutEffect(() => {
    const control = refocus.current
    refocus.current = null
    const dialog = dialogRef.current
    if (!control || !dialog) return
    const target = dialog.querySelector<HTMLElement>(`[data-preview-control="${control}"]:not(:disabled)`) ?? dialog.querySelector<HTMLElement>('.image-preview-stage')
    target?.focus({ preventScroll: true })
  }, [current.key])
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current!
    const unlock = lockPageScroll()
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-preview-control="close"]')?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' || isEditable(event.target)) return
      // An image wider than the stage keeps native keyboard scrolling.
      const stage = dialog.querySelector<HTMLElement>('.image-preview-stage')
      if (stage?.hasAttribute('data-actual-size') && stage.scrollWidth > stage.clientWidth) return
      event.preventDefault()
      navigateRef.current(event.key === 'ArrowLeft' ? -1 : 1)
    }
    // Ctrl/⌘ + wheel and WebKit pinch anywhere in the viewer never zoom the page.
    const block = (event: Event) => { if (event.type !== 'wheel' || (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey) event.preventDefault() }
    document.addEventListener('keydown', key)
    dialog.addEventListener('wheel', block, { passive: false })
    dialog.addEventListener('gesturestart', block)
    dialog.addEventListener('gesturechange', block)
    return () => {
      document.removeEventListener('keydown', key)
      dialog.removeEventListener('wheel', block)
      dialog.removeEventListener('gesturestart', block)
      dialog.removeEventListener('gesturechange', block)
      dialog.close()
      unlock()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(<dialog ref={dialogRef} data-image-preview data-frame-layer className="image-preview-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => event.stopPropagation()}>
    <Preview key={`${current.key}\n${current.mimeType}\n${current.src}`} image={current} own={current === ownImage ? { onDownload, downloadPending, downloadError } : undefined}
      index={index} count={count} titleId={titleId} onNavigate={navigate} onClose={onClose} />
  </dialog>, document.body)
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { requestImageDownloadUrl, triggerBrowserDownload } from './downloadShared'

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
}

function Preview({ src, mimeType, title, onClose, onDownload, downloadPending, downloadError }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number; startX: number; startY: number }>())
  const pinch = useRef<{ distance: number; scale: number; x: number; y: number } | null>(null)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const suppressClick = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const titleId = useId()
  const [failed, setFailed] = useState(!isSafeImagePreviewMime(mimeType))
  const [loaded, setLoaded] = useState(false)
  const [{ scale, actualSize }, setView] = useState({ scale: 1, actualSize: false })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [bounds, setBounds] = useState({ width: 0, height: 0, left: 0, top: 0 })
  const fit = natural.width && bounds.width ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height) : 1
  const imageWidth = natural.width * (actualSize ? scale : fit)
  const imageHeight = natural.height * (actualSize ? scale : fit)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
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
  const resetGesture = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a || !b) {
      pinch.current = null
      const stage = stageRef.current!
      pan.current = a ? { x: a.x, y: a.y, left: stage.scrollLeft, top: stage.scrollTop } : null
      return
    }
    pan.current = null
    const point = imagePoint((a.x + b.x) / 2, (a.y + b.y) / 2)
    pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: actualSize ? scale : fit, x: point.x, y: point.y }
    suppressClick.current = true
  }
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.size) suppressClick.current = false
    if (event.pointerType !== 'touch' || !loaded || failed) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY })
    // Capture on the original target so an ordinary tap still clicks the image.
    const target = event.target as HTMLElement
    target.setPointerCapture(event.pointerId)
    resetGesture()
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    event.preventDefault()
    pointers.current.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY })
    if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) > 6) suppressClick.current = true
    if (pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const nextScale = Math.min(Math.max(8 * fit, 1), Math.max(fit, pinch.current.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance))
      anchor.current = { x: pinch.current.x, y: pinch.current.y, clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }
      setView({ scale: nextScale, actualSize: nextScale > fit })
    } else if (actualSize && suppressClick.current && pan.current) {
      const stage = stageRef.current!
      // Keep fractional CSS-pixel intent, rather than adding each delta to a
      // browser-rounded scroll offset. Image zoom does not scale finger motion.
      const drag = pan.current
      drag.left = Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, drag.left + drag.x - event.clientX))
      drag.top = Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, drag.top + drag.y - event.clientY))
      drag.x = event.clientX
      drag.y = event.clientY
      stage.scrollTo(drag.left, drag.top)
    }
  }
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    if (event.type !== 'pointerup') suppressClick.current = true
    resetGesture()
  }
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const unlock = lockPageScroll()
    dialog?.showModal()
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      requestRef.current?.abort()
      dialog?.close()
      unlock()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  const download = async () => {
    if (onDownload) { onDownload(); return }
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    setPending(true); setError('')
    try {
      const downloadUrl = /^(?:blob:|data:)/i.test(src) ? src : await requestImageDownloadUrl(src, title, controller.signal)
      if (!controller.signal.aborted) triggerBrowserDownload(downloadUrl, title)
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === 'Image unavailable' ? 'Image unavailable' : 'Download unavailable')
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }
  return createPortal(<dialog ref={dialogRef} data-image-preview className="image-preview-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => event.stopPropagation()}>
    <header className="image-preview-header">
      <h2 id={titleId} title={title}>{title}</h2>
      <button type="button" className="image-preview-action" disabled={failed || !loaded} aria-label={actualSize ? 'Fit image' : 'Actual size'} aria-pressed={actualSize} title={actualSize ? 'Fit image' : 'Actual size'} onClick={toggleSize}>{actualSize ? <ZoomOut size={20} /> : <ZoomIn size={20} />}</button>
      <button type="button" className="image-preview-action" disabled={downloadPending || pending} aria-label={`Download ${title}`} title="Download" onClick={() => { void download() }}><Download size={20} /></button>
      <button ref={closeRef} type="button" className="image-preview-action" aria-label="Close image preview" title="Close" onClick={onClose}><X size={22} /></button>
    </header>
    <div ref={stageRef} className="image-preview-stage" data-actual-size={actualSize || undefined} tabIndex={0} aria-label="Image preview"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
      onContextMenu={event => event.preventDefault()}
      onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation() } }}
      onClick={event => { if (!actualSize && (event.target === event.currentTarget || event.target === surfaceRef.current)) onClose() }}>
      {failed ? <span role="status">Image unavailable</span> : <>
        {!loaded && <span role="status" className="image-preview-loading">Loading image…</span>}
        <div ref={surfaceRef} className="image-preview-surface" style={{ width: Math.max(bounds.width, imageWidth), height: Math.max(bounds.height, imageHeight) }}>
          <img ref={imageRef} src={src} alt={title} draggable={false} style={{ width: imageWidth, height: imageHeight }} onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true) }} onError={() => { setFailed(true); setLoaded(false) }} onClick={() => { toggleSize(); stageRef.current?.focus({ preventScroll: true }) }} />
        </div>
      </>}
    </div>
    {(downloadError || error) && <div role="alert" className="image-preview-error">{downloadError || error}</div>}
  </dialog>, document.body)
}

export default function ImagePreviewDialog(props: Props) {
  return <Preview key={`${props.mimeType}:${props.src}`} {...props} />
}

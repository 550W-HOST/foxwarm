export const TERMINAL_PINCH_MIN_FONT_SIZE = 10
export const TERMINAL_PINCH_MAX_FONT_SIZE = 24

export interface TerminalPinchPoint {
  clientX: number
  clientY: number
}

export function terminalPinchDistance(first: TerminalPinchPoint, second: TerminalPinchPoint): number {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
}

export function terminalPinchFontSize(
  startFontSize: number,
  startDistance: number,
  currentDistance: number,
  minFontSize = TERMINAL_PINCH_MIN_FONT_SIZE,
  maxFontSize = TERMINAL_PINCH_MAX_FONT_SIZE,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0 || !Number.isFinite(currentDistance)) {
    return Math.min(maxFontSize, Math.max(minFontSize, startFontSize))
  }
  const scaled = startFontSize * (currentDistance / startDistance)
  const rounded = Math.round(scaled * 2) / 2
  return Math.min(maxFontSize, Math.max(minFontSize, rounded))
}

interface TerminalPinchZoomOptions {
  target: HTMLElement
  getFontSize: () => number
  setFontSize: (fontSize: number) => void
  refit: () => void
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}

export function attachTerminalPinchZoom({
  target,
  getFontSize,
  setFontSize,
  refit,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle),
}: TerminalPinchZoomOptions): () => void {
  let gesture: { startDistance: number; startFontSize: number; appliedFontSize: number } | null = null
  let pendingFontSize: number | null = null
  let frameHandle: number | null = null

  const applyPending = () => {
    frameHandle = null
    if (!gesture || pendingFontSize === null || pendingFontSize === gesture.appliedFontSize) {
      pendingFontSize = null
      return
    }
    gesture.appliedFontSize = pendingFontSize
    pendingFontSize = null
    setFontSize(gesture.appliedFontSize)
    refit()
  }

  const scheduleApply = () => {
    if (frameHandle !== null) return
    frameHandle = requestFrame(applyPending)
  }

  const finish = (applyFinal: boolean) => {
    if (frameHandle !== null) {
      cancelFrame(frameHandle)
      frameHandle = null
    }
    if (applyFinal) applyPending()
    pendingFontSize = null
    gesture = null
  }

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      if (gesture) {
        event.stopPropagation()
        finish(false)
      }
      return
    }
    const distance = terminalPinchDistance(event.touches[0], event.touches[1])
    if (distance <= 0) return
    event.preventDefault()
    event.stopPropagation()
    finish(false)
    const fontSize = getFontSize()
    gesture = { startDistance: distance, startFontSize: fontSize, appliedFontSize: fontSize }
  }

  const move = (event: TouchEvent) => {
    if (!gesture) return
    if (event.touches.length !== 2) {
      event.stopPropagation()
      finish(event.touches.length < 2)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    pendingFontSize = terminalPinchFontSize(
      gesture.startFontSize,
      gesture.startDistance,
      terminalPinchDistance(event.touches[0], event.touches[1]),
    )
    scheduleApply()
  }

  const end = (event: TouchEvent) => {
    if (gesture && event.touches.length !== 2) {
      event.stopPropagation()
      finish(true)
    }
  }

  const cancel = (event: TouchEvent) => {
    if (gesture) {
      event.stopPropagation()
      finish(false)
    }
  }

  target.addEventListener('touchstart', start, { passive: false })
  target.addEventListener('touchmove', move, { passive: false })
  target.addEventListener('touchend', end, { passive: true })
  target.addEventListener('touchcancel', cancel, { passive: true })

  return () => {
    finish(false)
    target.removeEventListener('touchstart', start)
    target.removeEventListener('touchmove', move)
    target.removeEventListener('touchend', end)
    target.removeEventListener('touchcancel', cancel)
  }
}

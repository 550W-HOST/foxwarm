import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'

// A little fox curled up asleep: angular face with tall ears and closed eyes
// on the left, the back as one big circle, a curled haunch, and the tail
// sweeping round the front to a fluffy zig-zag tip. Everything is stroked with
// the theme accent (`--foxwarm-color-accent`).
const FOX = {
  head: 'M50 64 C40 58 26 52 8 49 L14 36 C10 26 10 16 14 6 C19 11 24 17 28 22 C33 21 37 21 41 22 C44 15 47 9 51 3 C55 12 55 22 52 31 L58 43 C54 50 51 57 50 64',
  eyeLeft: 'M20 41 C25 45 30 44 34 49',
  eyeRight: 'M43 47 C44 43 46.5 40.5 49 38',
  back: 'M60.3 16.4 A40 40 0 1 1 67 93.4 C52 90.8 24 92 8 88',
  haunch: 'M90 40 C78 42 70 52 70 71',
  chest: 'M12 50 C6 56 6 69 17 79.5',
  // One continuous line from the tip, just under the nose, then sagging toward the
  // bottom and curling up short of the back, so it reads as the tail lying
  // along the body instead of a line cutting it in half.
  tailTop: 'M8 88 C11 84 16 80.5 23 77.5 C31 74 41 72 51 71.5 C62 71 70 71 78 73 C86 75 92 79.5 98 80 C100.5 80.2 102.8 79 104.5 77',
  tailTip: 'M30 76 Q38 78 34.5 81.5 Q41 81 45 84',
  loop: 'M60.3 16.4 A40 40 0 1 1 67 93.4 C52 90.8 24 92 8 88',
}
const FOX_VIEWBOX = '2 -1 118 99'

type DelayStyle = CSSProperties & { '--fw-fox-delay'?: string }

const delay = (ms: number): DelayStyle => ({ '--fw-fox-delay': `${ms}ms` })

function DrawPath({ d, at, className = '' }: { d: string; at: number; className?: string }) {
  return <path d={d} pathLength={1} className={`fw-fox-draw ${className}`} style={delay(at)} />
}

function StaticPath({ d, className }: { d: string; at: number; className?: string }) {
  return <path d={d} className={className} />
}

/** The fox's lines; `at` staggers the draw-in when `draw` is set. */
function FoxLines({ draw }: { draw: boolean }) {
  const P = draw ? DrawPath : StaticPath
  return (
    <>
      <g className="fw-fox-body">
        <P d={FOX.back} at={130} />
        <P d={FOX.haunch} at={450} className="fw-fox-mid" />
        <P d={FOX.tailTop} at={310} />
        <P d={FOX.tailTip} at={525} className="fw-fox-thin" />
      </g>
      <g className="fw-fox-head">
        <P d={FOX.head} at={0} />
        <P d={FOX.chest} at={410} className="fw-fox-mid" />
        <P d={FOX.eyeLeft} at={575} className="fw-fox-mid" />
        <P d={FOX.eyeRight} at={600} className="fw-fox-mid" />
        <ellipse cx="51" cy="64.5" rx="4.6" ry="3.4" transform="rotate(-20 51 64.5)" className="fw-fox-nose" />
      </g>
    </>
  )
}

export interface FoxCubProps {
  size?: number | string
  className?: string
  /** Static renders the finished drawing without any motion. */
  animated?: boolean
  label?: string
}

/** Large animated fox: lines draw in, then it dozes (breathing, ear twitch, tail swish). */
export function FoxCub({ size = 180, className = '', animated = true, label = 'Foxwarm' }: FoxCubProps) {
  return (
    <svg
      viewBox={FOX_VIEWBOX}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={`fw-fox fw-fox-cub ${animated ? 'fw-fox-live' : 'fw-fox-static'} ${className}`}
      data-fox-loader="cub"
    >
      <FoxLines draw />
    </svg>
  )
}

/** The fox in faint lines with a comet running round its back and tail — a drop-in spinner. */
export function FoxSpinner({ size = 20, className = '' }: { size?: number | string; className?: string }) {
  return (
    <svg
      viewBox={FOX_VIEWBOX}
      width={size}
      height={size}
      aria-hidden="true"
      className={`fw-fox fw-fox-spinner ${className}`}
      data-fox-loader="spinner"
    >
      <g className="fw-fox-faint-all"><FoxLines draw={false} /></g>
      <path d={FOX.loop} pathLength={1} className="fw-fox-comet" />
    </svg>
  )
}

/** Inline thinking block: the fox spinner, sized for a status row. */
export function FoxThinking({ className = '', label }: { className?: string; label?: string }) {
  return (
    <span className={`fw-fox-thinking inline-flex items-center ${className}`} data-fox-loader="thinking" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <FoxSpinner size={20} />
    </span>
  )
}

/** Centered fox spinner + optional caption, for lazy views and panes. */
export function FoxPaneLoader({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <FoxSpinner size={36} />
      {label ? <div>{label}</div> : <span className="sr-only">Loading</span>}
    </div>
  )
}

// ---- Boot splash ----------------------------------------------------------

let bootReady = false
const bootListeners = new Set<() => void>()

export function markBootReady() {
  if (bootReady) return
  bootReady = true
  bootListeners.forEach(listener => listener())
}

function subscribeBoot(listener: () => void) {
  bootListeners.add(listener)
  return () => { bootListeners.delete(listener) }
}

/** Mount next to the real app content; signals the splash once it renders. */
export function BootReadySignal() {
  useEffect(() => { markBootReady() }, [])
  return null
}

// The draw-in finishes at ~1.3s, just before the splash may leave.
const SPLASH_MIN_MS = 1500
const SPLASH_FADE_MS = 480

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Full-screen entry splash with the drawing fox; fades out once the app is ready. */
export function FoxSplash() {
  const ready = useSyncExternalStore(subscribeBoot, () => bootReady, () => bootReady)
  const [minElapsed, setMinElapsed] = useState(false)
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>('shown')

  useEffect(() => {
    const timeout = window.setTimeout(() => setMinElapsed(true), prefersReducedMotion() ? 0 : SPLASH_MIN_MS)
    return () => window.clearTimeout(timeout)
  }, [])

  useEffect(() => {
    if (!ready || !minElapsed || phase !== 'shown') return
    setPhase('leaving')
  }, [minElapsed, phase, ready])

  useEffect(() => {
    if (phase !== 'leaving') return
    const timeout = window.setTimeout(() => setPhase('gone'), SPLASH_FADE_MS)
    return () => window.clearTimeout(timeout)
  }, [phase])

  if (phase === 'gone') return null
  return <FoxSplashScreen state={phase} animated={!prefersReducedMotion()} />
}

/** Presentational splash; `FoxSplash` drives its lifecycle. */
export function FoxSplashScreen({ state = 'shown', animated = true, onClick }: { state?: 'shown' | 'leaving'; animated?: boolean; onClick?: () => void }) {
  return (
    <div className="fw-fox-splash" data-state={state} data-fox-splash role="status" aria-label="Loading Foxwarm" onClick={onClick}>
      <FoxCub size="min(40vmin, 200px)" label="Foxwarm" animated={animated} />
    </div>
  )
}

import { useEffect, type CSSProperties } from 'react'
import foxDrawing from './foxDrawing.json'

// A little fox curled up asleep: angular face with tall ears and closed eyes
// on the left, the back as one big circle, a curled haunch, and the tail
// sweeping round the front to a fluffy zig-zag tip. Everything is stroked with
// the theme accent (`--foxwarm-color-accent`).
const FOX = foxDrawing.paths
const FOX_VIEWBOX = foxDrawing.viewBox

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

export function markBootReady() {
  window.foxwarmBoot?.ready()
}

/** Mount next to the real app content; signals the HTML screen once it renders. */
export function BootReadySignal() {
  useEffect(() => { markBootReady() }, [])
  return null
}

/** Presentational splash for the independent Appearance demo. */
export function FoxSplashScreen({ state = 'shown', animated = true, onClick }: { state?: 'shown' | 'leaving'; animated?: boolean; onClick?: () => void }) {
  return (
    <div className="fw-fox-splash" data-state={state} data-fox-splash role="status" aria-label="Loading Foxwarm" onClick={onClick}>
      <FoxCub size="min(40vmin, 200px)" label="Foxwarm" animated={animated} />
    </div>
  )
}

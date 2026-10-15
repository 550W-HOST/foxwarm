import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

export const FOX_THINKING_PHRASES = [
  'Negotiating with squirrels…',
  'Questioning a pinecone…',
  'Decoding forest gossip…',
  'Chasing a suspicious leaf…',
  'Consulting the moon…',
  'Counting imaginary chickens…',
  'Plotting something orange…',
  'Outfoxing entropy…',
  'Untangling moonbeams…',
  'Rearranging the universe…',
  'Following a questionable hunch…',
  'Taking the scenic route…',
  'Listening to mushrooms…',
  'Interviewing a firefly…',
  'Borrowing a little moonlight…',
  'Inspecting a very small mystery…',
  'Rehearsing a tiny plot twist…',
  'Reading between the branches…',
  'Following the breadcrumb trail…',
  'Asking an unusually wise pebble…',
  'Making room for an epiphany…',
  'Negotiating with gravity…',
  'Organizing a woodland conspiracy…',
  'Turning over a peculiar rock…',
  'Looking behind the obvious…',
  'Connecting improbable dots…',
  'Folding a thought into a fox…',
  'Consulting the inner squirrel…',
  'Keeping an eye on that acorn…',
  'Assembling a pocket universe…',
  'Sending a thought on a detour…',
  'Hatching an orange-tinted plan…',
] as const

export const FOX_EXEC_PHRASES = [
  'Prowling through the pines…',
  'Playing in the underbrush…',
  'Following fresh pawprints…',
  'Rustling through the leaves…',
  'Leaping over fallen branches…',
  'Darting between the birches…',
  'Digging up a hidden acorn…',
  'Padding along the forest floor…',
  'Chasing shadows through the ferns…',
  'Scampering across a mossy log…',
  'Tunneling under the brambles…',
  'Nosing around the old oak…',
  'Rolling in the wildflowers…',
  'Hopping across the creek…',
  'Sneaking through the tall grass…',
  'Wading through a sea of ferns…',
  'Scouting a secret shortcut…',
  'Pouncing on a pile of leaves…',
  'Trotting toward the tree line…',
  'Making tracks in the soft earth…',
  'Tugging at a stubborn root…',
  'Scrambling up a crooked trunk…',
  'Taking the pinecone express…',
  'Delivering a woodland surprise…',
] as const

const WIPE_MS = 450

/** Decorative thinking copy; the accessible status stays stable during rotation. */
export default function FoxThinkingText({ label = 'Thinking...', mode = 'thinking', title }: { label?: string; mode?: 'thinking' | 'exec'; title?: string }) {
  return <RotatingFoxCopy key={mode} mode={mode} label={label} title={title} phrases={mode === 'exec' ? FOX_EXEC_PHRASES : FOX_THINKING_PHRASES} />
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function RotatingFoxCopy({ label, mode, phrases, title }: { label: string; mode: 'thinking' | 'exec'; phrases: readonly string[]; title?: string }) {
  const measureRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number>()
  const [frame, setFrame] = useState(() => ({
    current: Math.floor(Math.random() * phrases.length),
    previous: null as number | null,
    generation: 0,
  }))

  useBrowserLayoutEffect(() => {
    const element = measureRef.current
    if (!element) return
    const measure = () => setWidth(Math.ceil(element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame.current])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFrame(previous => ({
        current: (previous.current + 1 + Math.floor(Math.random() * (phrases.length - 1))) % phrases.length,
        previous: previous.current,
        generation: previous.generation + 1,
      }))
    }, 5000 + Math.random() * 2000)
    return () => window.clearTimeout(timeout)
  }, [frame.current])

  useEffect(() => {
    if (frame.previous === null) return
    const timeout = window.setTimeout(() => setFrame(previous => ({ ...previous, previous: null })), WIPE_MS)
    return () => window.clearTimeout(timeout)
  }, [frame.generation, frame.previous])

  return (
    <span className="fw-fox-thinking-copy" data-fox-thinking-copy data-fox-copy-mode={mode} data-thinking-transition={frame.generation > 0 || undefined} style={{ '--fw-fox-copy-width': width === undefined ? undefined : `${width}px` } as CSSProperties}>
      <span className="sr-only">{label}</span>
      <span ref={measureRef} className="fw-fox-thinking-measure" aria-hidden="true">{phrases[frame.current]}</span>
      <span className="fw-fox-thinking-phrases" aria-hidden="true" title={title || phrases[frame.current]} style={{ '--fw-fox-copy-duration': `${WIPE_MS}ms` } as CSSProperties}>
        {frame.previous !== null && <span key={frame.generation - 1} data-thinking-phrase="outgoing">{phrases[frame.previous]}</span>}
        <span key={frame.generation} data-thinking-phrase={frame.generation ? 'incoming' : 'initial'}>{phrases[frame.current]}</span>
      </span>
    </span>
  )
}

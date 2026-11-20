import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, MessageCircleQuestion } from 'lucide-react'
import { getQuestionSectionPlacement, nextQuestionHintAnnouncement, questionHintLabel, shouldShowQuestionHint, type QuestionSectionPlacement } from '../sessionQuestionHint'

interface SessionListQuestionHintProps {
  /** The list's scroll container. */
  scroller: HTMLElement | null
  /** The rendered `Needs your answer` section, or null when the list does not show it. */
  section: HTMLElement | null
  /** Sessions in the section. */
  count: number
}

function readPlacement(scroller: HTMLElement | null, section: HTMLElement | null): QuestionSectionPlacement {
  if (!scroller || !section) return 'none'
  // The mobile page header overlays the list and the list pads its content below it.
  const visibleTop = scroller.getBoundingClientRect().top + (parseFloat(getComputedStyle(scroller).paddingTop) || 0)
  return getQuestionSectionPlacement(section.getBoundingClientRect(), visibleTop)
}

/**
 * Floating hint at the top of the list's scroll area while the `Needs your answer` section is
 * scrolled out of view. It overlays the list, so showing it never moves rows; activating it scrolls
 * back to the top and moves focus to the section.
 */
export default function SessionListQuestionHint({ scroller, section, count }: SessionListQuestionHintProps) {
  const [placement, setPlacement] = useState<QuestionSectionPlacement>('none')
  const [announcement, setAnnouncement] = useState('')
  const baselineRef = useRef(0)

  useLayoutEffect(() => {
    setPlacement(readPlacement(scroller, section))
    if (!scroller || !section) return
    let frame = 0
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; setPlacement(readPlacement(scroller, section)) })
    }
    scroller.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(scroller)
    observer?.observe(section)
    return () => {
      scroller.removeEventListener('scroll', update)
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, section])

  // A changed count resizes the section; read the committed layout rather than a placement that
  // may predate it, so the announcement matches what the list now shows.
  useEffect(() => {
    const current = readPlacement(scroller, section)
    const next = nextQuestionHintAnnouncement(baselineRef.current, count, current)
    baselineRef.current = next.baseline
    if (next.announce) setAnnouncement(questionHintLabel(count))
    else if (!shouldShowQuestionHint(count, current)) setAnnouncement('')
  }, [count, placement, scroller, section])

  const visible = shouldShowQuestionHint(count, placement)
  const showSection = () => {
    if (!scroller || !section) return
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
    // The hint disappears once the section is back; keep focus with what it pointed to.
    section.focus({ preventScroll: true })
  }

  return (
    <>
      <div role="status" className="sr-only" data-session-question-hint-status>{announcement}</div>
      {visible && (
        <div className="session-question-hint-layer pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-1.5">
          <button
            type="button"
            onClick={showSection}
            data-session-question-hint={count}
            className="session-question-hint pointer-events-auto inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-fw-accent-border bg-fw-surface-raised px-3 text-xs font-medium text-fw-text-strong shadow-lg transition-colors hover:bg-fw-accent-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/50"
          >
            <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-fw-accent" aria-hidden="true" />
            <span className="min-w-0 truncate">{questionHintLabel(count)}</span>
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-fw-text-muted" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}

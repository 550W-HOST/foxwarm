import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

/** Pane width from which a System section shows its list and details side by side. */
export const SYSTEM_SPLIT_MIN_WIDTH = 760

/**
 * List/detail state of one System section. The layout follows the width of the section's own
 * pane, not the viewport: side by side when there is room, otherwise (and on phones) the list
 * alone, with a selection opening the details as a page with Back.
 */
export function useSystemSplit(phone: boolean) {
  const [width, setWidth] = useState(0)
  const [detailOpen, setDetailOpen] = useState(false)
  const element = useRef<HTMLDivElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const listScroll = useRef(0)
  // The narrow and wide layouts render different root elements; observe whichever is mounted.
  const ref = useCallback((next: HTMLDivElement | null) => {
    observer.current?.disconnect(); observer.current = null
    element.current = next
    if (!next) return
    setWidth(next.getBoundingClientRect().width)
    observer.current = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.current.observe(next)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  const narrow = phone || (width > 0 && width < SYSTEM_SPLIT_MIN_WIDTH)
  useEffect(() => { if (!narrow) setDetailOpen(false) }, [narrow])
  // A narrow layout scrolls as one page: a detail page starts at its top, and Back returns to
  // where the list was.
  const scroller = () => element.current?.closest<HTMLElement>('[data-system-scroll]') || null
  const open = () => {
    if (!narrow) return
    if (!detailOpen) listScroll.current = scroller()?.scrollTop || 0
    setDetailOpen(true)
    requestAnimationFrame(() => scroller()?.scrollTo({ top: 0 }))
  }
  const close = () => {
    setDetailOpen(false)
    requestAnimationFrame(() => scroller()?.scrollTo({ top: listScroll.current }))
  }
  return { ref, narrow, detailOpen: narrow && detailOpen, open, close }
}

export type SystemSplitState = ReturnType<typeof useSystemSplit>

/**
 * A System section with an optional toolbar, a list and a detail pane. When wide, the toolbar
 * stays put and the list and the details scroll independently inside the section's height.
 */
export function SystemSplit({ split, name, toolbar, list, detail, backLabel, detailWidth = 'minmax(360px,440px)' }: {
  split: SystemSplitState
  name: string
  toolbar?: ReactNode
  list: ReactNode
  detail: ReactNode
  backLabel: string
  detailWidth?: string
}) {
  if (split.narrow) return (
    <div ref={split.ref} className="pb-4" data-system-split={name} data-system-split-layout={split.detailOpen ? 'detail' : 'list'}>
      {split.detailOpen ? (
        <>
          <button type="button" onClick={split.close} data-system-split-back className="mb-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-fw-accent hover:bg-fw-accent-surface">
            <ArrowLeft className="h-4 w-4" />{backLabel}
          </button>
          <div data-system-split-detail>{detail}</div>
        </>
      ) : (
        <>
          {toolbar ? <div className="mb-3">{toolbar}</div> : null}
          <div data-system-split-list>{list}</div>
        </>
      )}
    </div>
  )
  return (
    <div ref={split.ref} className="flex h-full min-h-0 flex-col" data-system-split={name} data-system-split-layout="split">
      {toolbar ? <div className="mb-3 shrink-0">{toolbar}</div> : null}
      <div className="grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: `minmax(0,1fr) ${detailWidth}` }}>
        <div className="min-h-0 overflow-y-auto pr-1" data-system-split-list data-system-pane-scroll="list">{list}</div>
        <div className="min-h-0 overflow-y-auto" data-system-split-detail data-system-pane-scroll="detail">{detail}</div>
      </div>
    </div>
  )
}

export function SystemEmptyDetail({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border border-dashed border-fw-border-strong p-6 text-center text-sm text-fw-text-muted">
      <span className="mb-2 text-fw-text">{icon}</span>{title}
    </div>
  )
}

import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** In-flow content scrolls behind this transparent, progressively blurred header. */
export default function MobilePageHeader({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const header = ref.current
    const parent = header?.parentElement
    if (!header || !parent) return
    const measure = () => { const height = header.getBoundingClientRect().height; if (height > 0) parent.style.setProperty('--mobile-page-header-height', `${height}px`) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => { observer.disconnect(); parent.style.removeProperty('--mobile-page-header-height') }
  }, [])
  return <header ref={ref} data-mobile-page-header className="mobile-page-header mobile-top-fade">
    <div className="flex min-h-16 min-w-0 items-center justify-between gap-2 px-4 py-2">
      <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-fw-text-strong">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
    {children && <div className="px-4 pb-3">{children}</div>}
  </header>
}

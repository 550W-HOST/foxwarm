// The sidebar's brand: the instance's emoji and name from the WebUI settings when they are
// set, otherwise the Foxwarm logo and name. Inside a Desktop host it is a button that asks
// the host to open its native instance menu below it; elsewhere it is a plain heading.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { FoxwarmMark } from './FoxwarmMark'
import { hasHostChannel, requestInstanceMenu } from '../windowFrame'

export type InstanceBranding = { instanceName: string; tabIcon: string }

const OVERFLOW_ATTRIBUTE = 'data-brand-overflow'
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Whether the brand's full name is wider than the space its row leaves beside the other
 * controls. Measured the same way whether index.css shows the name or has taken it out of
 * the flow (after the macOS lights), so the answer doesn't flip with its own effect.
 */
export function brandNameOverflows(heading: HTMLElement): boolean {
  const row = heading.parentElement
  const name = heading.querySelector<HTMLElement>('.foxwarm-sidebar-wordmark')
  const holder = name?.parentElement
  if (!row || !name || !holder) return false
  const nameStyle = getComputedStyle(name)
  if (nameStyle.display === 'none') return false
  const rowBox = row.getBoundingClientRect()
  const rowStyle = getComputedStyle(row)
  const start = rowBox.left + (parseFloat(rowStyle.borderLeftWidth) || 0) + (parseFloat(rowStyle.paddingLeft) || 0)
  let end = rowBox.right - (parseFloat(rowStyle.borderRightWidth) || 0) - (parseFloat(rowStyle.paddingRight) || 0)
  for (const sibling of row.children) {
    if (sibling === heading) continue
    const box = sibling.getBoundingClientRect()
    if (box.width > 0) end = Math.min(end, box.left - (parseFloat(rowStyle.columnGap) || 0))
  }
  const gap = parseFloat(getComputedStyle(holder).columnGap) || 0
  const inFlow = nameStyle.position !== 'absolute'
  // The heading without the name (icon, paddings, margins), then with its full width.
  const base = heading.getBoundingClientRect().width - (inFlow ? name.getBoundingClientRect().width + gap : 0)
  const range = document.createRange()
  range.selectNodeContents(name)
  const needed = base + gap + range.getBoundingClientRect().width
  return needed > end - start + 0.02
}

export default function InstanceBrand({ branding, hosted = hasHostChannel() }: { branding: InstanceBranding; hosted?: boolean }) {
  const icon = branding.tabIcon.trim()
  const name = branding.instanceName.trim()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Marks the heading while the full name doesn't fit; after the macOS lights index.css then
  // shows the icon alone instead of a truncated name. Re-measured whenever the row, the
  // brand, the name or the controls beside it change size, and when fonts finish loading.
  useBrowserLayoutEffect(() => {
    const heading = headingRef.current
    if (!heading || typeof ResizeObserver === 'undefined') return
    const measure = () => heading.toggleAttribute(OVERFLOW_ATTRIBUTE, brandNameOverflows(heading))
    const observer = new ResizeObserver(measure)
    const row = heading.parentElement
    for (const element of [heading, ...heading.querySelectorAll('.foxwarm-sidebar-wordmark'), ...(row ? [row, ...row.children] : [])]) observer.observe(element)
    document.fonts?.addEventListener('loadingdone', measure)
    measure()
    return () => {
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', measure)
    }
  }, [icon, name, hosted])

  const content = <>
    {icon
      ? <span className="foxwarm-sidebar-brand-icon shrink-0" aria-hidden="true">{icon}</span>
      : <FoxwarmMark className="foxwarm-sidebar-brand-mark h-6 w-6 shrink-0" />}
    {/* Under the macOS lights only the default wordmark gives way to the menu bar's app name. */}
    <span className="foxwarm-sidebar-wordmark truncate" data-brand-default={name ? undefined : ''}>{name || 'Foxwarm'}</span>
  </>
  return (
    <h1 ref={headingRef} className="flex min-w-0 items-center gap-2 text-xl font-bold text-fw-text-strong" data-instance-brand="">
      {hosted
        ? <button
            type="button"
            data-instance-menu=""
            aria-haspopup="menu"
            title="Switch instance"
            onClick={event => { requestInstanceMenu(event.currentTarget.getBoundingClientRect()) }}
            className="foxwarm-instance-menu-button -mx-1.5 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-inherit hover:bg-fw-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40"
          >{content}</button>
        : content}
    </h1>
  )
}

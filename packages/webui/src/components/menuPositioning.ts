import { useEffect, type RefObject } from 'react'

export type HorizontalViewportBounds = {
  left: number
  right: number
}

export type HorizontalMenuPlacement = {
  left: number
  offset: number
  maxWidth: number
}

export const MENU_VIEWPORT_GUTTER = 8

export function clampAnchoredMenuHorizontally({
  anchorLeft,
  anchorRight,
  menuWidth,
  viewport,
  align,
  gutter = MENU_VIEWPORT_GUTTER,
}: {
  anchorLeft: number
  anchorRight: number
  menuWidth: number
  viewport: HorizontalViewportBounds
  align: 'start' | 'end'
  gutter?: number
}): HorizontalMenuPlacement {
  const maxWidth = Math.max(0, viewport.right - viewport.left - gutter * 2)
  const width = Math.min(Math.max(0, menuWidth), maxWidth)
  const preferredLeft = align === 'start' ? anchorLeft : anchorRight - width
  const minimumLeft = viewport.left + gutter
  const maximumLeft = Math.max(minimumLeft, viewport.right - gutter - width)
  const left = Math.min(Math.max(preferredLeft, minimumLeft), maximumLeft)

  return {
    left,
    offset: left - preferredLeft,
    maxWidth,
  }
}

export function readHorizontalViewportBounds(): HorizontalViewportBounds {
  const visualViewport = window.visualViewport
  const layoutRight = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth)
  const bodyRect = document.body?.getBoundingClientRect()
  const bodyLeft = bodyRect ? Math.max(0, bodyRect.left) : 0
  const bodyRight = bodyRect ? Math.min(layoutRight, bodyRect.right) : layoutRight
  const visualLeft = visualViewport?.offsetLeft ?? 0
  const visualRight = visualLeft + (visualViewport?.width ?? layoutRight)
  const left = Math.max(bodyLeft, visualLeft)
  const right = Math.min(bodyRight, visualRight)

  return right > left ? { left, right } : { left: 0, right: layoutRight }
}

export const MENU_ANCHOR_GAP = 6

export type VerticalMenuPlacement = {
  top: number
  side: 'below' | 'above'
  /** Set only when `shrinkToFit` had to limit the menu to the larger side. */
  maxHeight?: number
}

/**
 * Places a menu below its anchor, flips it above when only that side has room,
 * and otherwise either clamps it into the viewport (fixed-height menus) or, with
 * `shrinkToFit`, limits it to the larger side so its own content scrolls.
 */
export function placeAnchoredMenuVertically({
  anchorTop,
  anchorBottom,
  menuHeight,
  viewportHeight,
  shrinkToFit = false,
  gap = MENU_ANCHOR_GAP,
  gutter = MENU_VIEWPORT_GUTTER,
}: {
  anchorTop: number
  anchorBottom: number
  menuHeight: number
  viewportHeight: number
  shrinkToFit?: boolean
  gap?: number
  gutter?: number
}): VerticalMenuPlacement {
  const below = viewportHeight - gutter - (anchorBottom + gap)
  const above = anchorTop - gap - gutter
  if (menuHeight <= below) return { top: anchorBottom + gap, side: 'below' }
  if (menuHeight <= above) return { top: anchorTop - gap - menuHeight, side: 'above' }
  if (shrinkToFit) {
    return below >= above
      ? { top: anchorBottom + gap, side: 'below', maxHeight: Math.max(0, below) }
      : { top: gutter, side: 'above', maxHeight: Math.max(0, above) }
  }
  const top = Math.min(Math.max(gutter, anchorBottom + gap), Math.max(gutter, viewportHeight - menuHeight - gutter))
  return { top, side: 'below' }
}

/**
 * Menus render in a portal so scrolling containers cannot clip them. A modal
 * `<dialog>` is in the top layer and makes the rest of the document inert, so a
 * menu opened from inside one renders into that dialog instead of the body.
 */
export function menuPortalContainer(anchor: Element | null | undefined): HTMLElement {
  const dialog = anchor?.closest('dialog')
  return dialog instanceof HTMLDialogElement && dialog.open ? dialog : document.body
}

/**
 * Shared dismissal for anchored menus: outside pointer presses, Escape (unless
 * the owner handles keys itself), viewport resize and, unless `keepOnScroll`,
 * scrolling outside the menu, because a scrolled trigger moves away. With
 * `scrollAnchor`, only a scroll that actually moves that element dismisses, so
 * a scroll still settling from before the menu opened does not.
 */
export function useMenuDismissal({
  open,
  menuRef,
  insideRefs = [],
  onDismiss,
  escape = true,
  keepOnScroll = false,
  scrollAnchor,
}: {
  open: boolean
  menuRef: RefObject<HTMLElement | null>
  insideRefs?: ReadonlyArray<RefObject<HTMLElement | null>>
  onDismiss: () => void
  escape?: boolean
  keepOnScroll?: boolean
  scrollAnchor?: RefObject<HTMLElement | null>
}) {
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node
      && [menuRef, ...insideRefs].some(ref => ref.current?.contains(target))
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!inside(event.target)) onDismiss()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (escape && event.key === 'Escape') onDismiss()
    }
    const anchorAt = scrollAnchor?.current?.getBoundingClientRect()
    const handleScroll = (event: Event) => {
      if (keepOnScroll || inside(event.target)) return
      const now = scrollAnchor?.current?.getBoundingClientRect()
      if (anchorAt && now && Math.abs(now.top - anchorAt.top) < 1 && Math.abs(now.left - anchorAt.left) < 1) return
      onDismiss()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', handleScroll, true)
    }
    // insideRefs holds stable ref objects; a new array each render must not re-subscribe.
  }, [open, onDismiss, escape, keepOnScroll, menuRef])
}

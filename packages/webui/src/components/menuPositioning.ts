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
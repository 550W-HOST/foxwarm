/**
 * Logic of the Session list hint that points back to the `Needs your answer` section once it has
 * scrolled out of view. Kept free of React and the DOM so it can be tested directly.
 */

/** Where the `Needs your answer` section is relative to the visible top of the list. */
export type QuestionSectionPlacement = 'none' | 'in-view' | 'out'

/**
 * A sliver of the section thinner than this does not count as visible: it shows no readable row,
 * so the hint stays up until a meaningful part of the section is back in view.
 */
export const QUESTION_SECTION_MIN_VISIBLE_PX = 12

/**
 * Placement of the section, given its bounding box and the top edge of the list's visible area
 * (the scroll container's content top, below any header that overlays it). The section is always
 * the first content of the list, so it can only leave the view upwards.
 */
export function getQuestionSectionPlacement(section: { bottom: number } | null | undefined, visibleTop: number): QuestionSectionPlacement {
  if (!section) return 'none'
  return section.bottom - visibleTop < QUESTION_SECTION_MIN_VISIBLE_PX ? 'out' : 'in-view'
}

export function shouldShowQuestionHint(count: number, placement: QuestionSectionPlacement): boolean {
  return count > 0 && placement === 'out'
}

export function questionHintLabel(count: number): string {
  return count === 1 ? '1 session waiting for your answer' : `${count} sessions waiting for your answer`
}

/**
 * Decides whether the hint's count should be announced. `baseline` is the count the user was last
 * shown, by the section itself or by the hint. Scrolling alone never announces; a count that
 * changed while the section is out of view does, once, including the hint's first appearance for
 * a newly opened question. `none` with a positive count is a not yet measured section and keeps
 * the baseline.
 */
export function nextQuestionHintAnnouncement(baseline: number, count: number, placement: QuestionSectionPlacement): { baseline: number; announce: boolean } {
  if (count <= 0) return { baseline: 0, announce: false }
  if (placement === 'none') return { baseline, announce: false }
  if (placement === 'in-view') return { baseline: count, announce: false }
  return { baseline: count, announce: count !== baseline }
}

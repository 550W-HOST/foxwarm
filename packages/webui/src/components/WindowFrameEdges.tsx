/**
 * Window-frame drag spacers (see windowFrame.ts). They render nothing visible and are
 * hidden unless a frame provider is active.
 */

/** Drag gaps at both ends of an inline title row (a tab strip), sized to its reserved space. */
export function FrameEdges() {
  return <>
    <div aria-hidden="true" data-frame-drag data-frame-edge="start" className="foxwarm-frame-edge" />
    <div aria-hidden="true" data-frame-drag data-frame-edge="end" className="foxwarm-frame-edge" />
  </>
}

import { memo, useCallback, useMemo, useRef } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { Diff } from './chatShared'
import { SyntaxHighlightedText } from './SyntaxHighlightedText'

const DiffPreview = memo(function DiffPreview({ oldText, newText, diffViewMode, filePath }: { oldText: string; newText: string; diffViewMode: 'unified' | 'split'; filePath?: string }) {
  const lineChanges = useMemo(() => Diff.diffLines(oldText, newText), [oldText, newText])
  const diffOldScrollRefs = useRef<HTMLDivElement | null>(null)
  const diffNewScrollRefs = useRef<HTMLDivElement | null>(null)
  const diffLastScrollSide = useRef<'old' | 'new' | null>(null)

  const handleOldScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (diffLastScrollSide.current === 'new') return
    diffLastScrollSide.current = 'old'
    const oldDiv = e.currentTarget
    const newDiv = diffNewScrollRefs.current
    if (newDiv) {
      newDiv.scrollLeft = oldDiv.scrollLeft
      newDiv.scrollTop = oldDiv.scrollTop
    }
    setTimeout(() => {
      diffLastScrollSide.current = null
    }, 50)
  }, [])

  const handleNewScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (diffLastScrollSide.current === 'old') return
    diffLastScrollSide.current = 'new'
    const newDiv = e.currentTarget
    const oldDiv = diffOldScrollRefs.current
    if (oldDiv) {
      oldDiv.scrollLeft = newDiv.scrollLeft
      oldDiv.scrollTop = newDiv.scrollTop
    }
    setTimeout(() => {
      diffLastScrollSide.current = null
    }, 50)
  }, [])

  if (diffViewMode === 'unified') {
    const elements: ReactNode[] = []
    let i = 0

    while (i < lineChanges.length) {
      const change = lineChanges[i]

      if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
        const charDiff = Diff.diffWords(change.value, lineChanges[i + 1].value)
        elements.push(
          <div key={i} className="foxwarm-diff-removed-line bg-fw-diff-removed-surface pl-2">
            {charDiff.map((part, j) => part.removed
              ? <span key={j} className="foxwarm-diff-removed-token bg-fw-diff-removed-surface-strong text-fw-warning"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.added ? <span key={j} className="text-fw-text-strong"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        elements.push(
          <div key={i + 1} className="foxwarm-diff-added-line bg-fw-diff-added-surface pl-2">
            {charDiff.map((part, j) => part.added
              ? <span key={j} className="foxwarm-diff-added-token bg-fw-diff-added-surface-strong text-fw-accent"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.removed ? <span key={j} className="text-fw-text-strong"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        i += 2
      } else if (change.removed) {
        elements.push(<div key={i} className="foxwarm-diff-removed-line bg-fw-diff-removed-surface pl-2"><span className="text-fw-text-strong"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else if (change.added) {
        elements.push(<div key={i} className="foxwarm-diff-added-line bg-fw-diff-added-surface pl-2"><span className="text-fw-text-strong"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else {
        elements.push(<div key={i} className="pl-2"><span className="text-fw-text-strong"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      }
    }

    return <div className="foxwarm-diff-preview font-mono text-xs bg-fw-surface-sunken dark:bg-fw-canvas p-2 rounded border border-fw-border-strong whitespace-pre-wrap break-all cursor-text">{elements}</div>
  }

  const oldElements: ReactNode[] = []
  const newElements: ReactNode[] = []
  let i = 0

  while (i < lineChanges.length) {
    const change = lineChanges[i]

    if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
      const removedLinesSplit = change.value.split('\n')
      const addedLinesSplit = lineChanges[i + 1].value.split('\n')
      const removedLines = change.value.endsWith('\n') ? removedLinesSplit.slice(0, -1) : removedLinesSplit
      const addedLines = lineChanges[i + 1].value.endsWith('\n') ? addedLinesSplit.slice(0, -1) : addedLinesSplit
      const maxLines = Math.max(removedLines.length, addedLines.length)

      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        const removedLine = removedLines[lineIdx]
        const addedLine = addedLines[lineIdx]

        if (removedLine !== undefined && addedLine !== undefined) {
          const charDiff = Diff.diffWords(removedLine, addedLine)
          oldElements.push(
            <div key={`${i}-old-${lineIdx}`} className="foxwarm-diff-removed-line bg-fw-diff-removed-surface block">
              {charDiff.map((part, j) => part.removed
                ? <span key={j} className="foxwarm-diff-removed-token bg-fw-diff-removed-surface-strong text-fw-warning"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.added ? <span key={j} className="text-fw-text-strong"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
          newElements.push(
            <div key={`${i}-new-${lineIdx}`} className="foxwarm-diff-added-line bg-fw-diff-added-surface block">
              {charDiff.map((part, j) => part.added
                ? <span key={j} className="foxwarm-diff-added-token bg-fw-diff-added-surface-strong text-fw-accent"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.removed ? <span key={j} className="text-fw-text-strong"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
        } else if (removedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-${lineIdx}`} className="foxwarm-diff-removed-line bg-fw-diff-removed-surface text-fw-text-strong block"><SyntaxHighlightedText text={removedLine || '\u00A0'} filePath={filePath} /></div>)
          newElements.push(<div key={`${i}-new-pad-${lineIdx}`} className="bg-fw-neutral-surface dark:bg-fw-surface text-fw-text-muted dark:text-fw-text select-none block">&nbsp;</div>)
        } else if (addedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-pad-${lineIdx}`} className="bg-fw-neutral-surface dark:bg-fw-surface text-fw-text-muted dark:text-fw-text select-none block">&nbsp;</div>)
          newElements.push(<div key={`${i}-new-${lineIdx}`} className="foxwarm-diff-added-line bg-fw-diff-added-surface text-fw-text-strong block"><SyntaxHighlightedText text={addedLine || '\u00A0'} filePath={filePath} /></div>)
        }
      }

      i += 2
    } else if (change.removed) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-${lineIdx}`} className="foxwarm-diff-removed-line bg-fw-diff-removed-surface text-fw-text-strong block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
        newElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-fw-neutral-surface dark:bg-fw-surface text-fw-text-muted dark:text-fw-text select-none block">&nbsp;</div>)
      })
      i++
    } else if (change.added) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-fw-neutral-surface dark:bg-fw-surface text-fw-text-muted dark:text-fw-text select-none block">&nbsp;</div>)
        newElements.push(<div key={`${i}-${lineIdx}`} className="foxwarm-diff-added-line bg-fw-diff-added-surface text-fw-text-strong block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
      })
      i++
    } else {
      oldElements.push(<div key={i} className="text-fw-text-strong block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
      newElements.push(<div key={i} className="text-fw-text-strong block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
      i++
    }
  }

  return (
    <div className="foxwarm-diff-preview font-mono text-xs border border-fw-border-strong rounded overflow-hidden cursor-text">
      <div className="grid grid-cols-2">
        <div className="bg-fw-surface-sunken dark:bg-fw-canvas">
          <div className="foxwarm-diff-removed-header bg-fw-diff-removed-surface text-fw-warning font-semibold px-2 py-1 border-b border-fw-border-strong">- Old</div>
          <div ref={diffOldScrollRefs} onScroll={handleOldScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{oldElements}</div>
          </div>
        </div>
        <div className="bg-fw-surface-sunken dark:bg-fw-canvas border-l border-fw-border-strong">
          <div className="foxwarm-diff-added-header bg-fw-diff-added-surface text-fw-accent font-semibold px-2 py-1 border-b border-fw-border-strong">+ New</div>
          <div ref={diffNewScrollRefs} onScroll={handleNewScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{newElements}</div>
          </div>
        </div>
      </div>
    </div>
  )
})

export default DiffPreview

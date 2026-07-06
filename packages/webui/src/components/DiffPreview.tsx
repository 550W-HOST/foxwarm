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
          <div key={i} className="foxwarm-diff-removed-line bg-orange-100 dark:bg-orange-900/40 pl-2">
            {charDiff.map((part, j) => part.removed
              ? <span key={j} className="foxwarm-diff-removed-token bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        elements.push(
          <div key={i + 1} className="foxwarm-diff-added-line bg-blue-100 dark:bg-blue-900/40 pl-2">
            {charDiff.map((part, j) => part.added
              ? <span key={j} className="foxwarm-diff-added-token bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        i += 2
      } else if (change.removed) {
        elements.push(<div key={i} className="foxwarm-diff-removed-line bg-orange-100 dark:bg-orange-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else if (change.added) {
        elements.push(<div key={i} className="foxwarm-diff-added-line bg-blue-100 dark:bg-blue-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else {
        elements.push(<div key={i} className="pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      }
    }

    return <div className="foxwarm-diff-preview font-mono text-xs bg-gray-50 dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 whitespace-pre-wrap break-all cursor-text">{elements}</div>
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
            <div key={`${i}-old-${lineIdx}`} className="foxwarm-diff-removed-line bg-orange-100 dark:bg-orange-900/40 block">
              {charDiff.map((part, j) => part.removed
                ? <span key={j} className="foxwarm-diff-removed-token bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
          newElements.push(
            <div key={`${i}-new-${lineIdx}`} className="foxwarm-diff-added-line bg-blue-100 dark:bg-blue-900/40 block">
              {charDiff.map((part, j) => part.added
                ? <span key={j} className="foxwarm-diff-added-token bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
        } else if (removedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-${lineIdx}`} className="foxwarm-diff-removed-line bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={removedLine || '\u00A0'} filePath={filePath} /></div>)
          newElements.push(<div key={`${i}-new-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        } else if (addedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
          newElements.push(<div key={`${i}-new-${lineIdx}`} className="foxwarm-diff-added-line bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={addedLine || '\u00A0'} filePath={filePath} /></div>)
        }
      }

      i += 2
    } else if (change.removed) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-${lineIdx}`} className="foxwarm-diff-removed-line bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
        newElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
      })
      i++
    } else if (change.added) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        newElements.push(<div key={`${i}-${lineIdx}`} className="foxwarm-diff-added-line bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
      })
      i++
    } else {
      oldElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
      newElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
      i++
    }
  }

  return (
    <div className="foxwarm-diff-preview font-mono text-xs border border-gray-300 dark:border-gray-600 rounded overflow-hidden cursor-text">
      <div className="grid grid-cols-2">
        <div className="bg-gray-50 dark:bg-gray-900">
          <div className="foxwarm-diff-removed-header bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">- Old</div>
          <div ref={diffOldScrollRefs} onScroll={handleOldScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{oldElements}</div>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 border-l border-gray-300 dark:border-gray-600">
          <div className="foxwarm-diff-added-header bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">+ New</div>
          <div ref={diffNewScrollRefs} onScroll={handleNewScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{newElements}</div>
          </div>
        </div>
      </div>
    </div>
  )
})

export default DiffPreview

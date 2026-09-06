import { memo } from 'react'

interface MarkdownHtmlSegmentProps {
  html: string
}

const MarkdownHtmlSegment = memo(function MarkdownHtmlSegment({ html }: MarkdownHtmlSegmentProps) {
  return (
    <div
      className="foxwarm-markdown-segment"
      style={{ display: 'contents' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

export default MarkdownHtmlSegment
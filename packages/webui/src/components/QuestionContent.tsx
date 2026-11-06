import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Download, File, Image as ImageIcon } from 'lucide-react'
import { projectQuestionContent, type QuestionAttachment } from '../questionContent'
import { handleMarkdownLinkClick } from './chatShared'
import { buildPathDownloadUrl, requestPathDownloadUrl, triggerBrowserDownload } from './downloadShared'
import ImagePreviewDialog, { isSafeImagePreviewMime } from './ImagePreviewDialog'
import { renderMarkdownSegments } from './markdownRenderer'
import MarkdownHtmlSegment from './MarkdownHtmlSegment'

function AnswerAttachment({ attachment }: { attachment: QuestionAttachment }) {
  const [preview, setPreview] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])
  const local = attachment.node === 'master' && !!attachment.path && /^(?:\/|[A-Za-z]:[\\/])/.test(attachment.path) && !attachment.path.includes('\0')
  const image = attachment.kind === 'image' && isSafeImagePreviewMime(attachment.mimeType)
  const url = local ? buildPathDownloadUrl(attachment.path!, { fileName: attachment.name }) : ''
  const download = async () => {
    if (!local || request.current) return
    const controller = new AbortController(); request.current = controller
    setPending(true); setError('')
    try {
      const signed = await requestPathDownloadUrl(url, controller.signal)
      if (mounted.current && !controller.signal.aborted) triggerBrowserDownload(signed, attachment.name)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error && cause.message === 'File unavailable' ? 'File unavailable' : 'Download unavailable')
    } finally {
      if (request.current === controller) request.current = null
      if (mounted.current && !controller.signal.aborted) setPending(false)
    }
  }
  const Icon = attachment.kind === 'image' ? ImageIcon : File
  return (
    <div className="min-w-0" data-question-attachment={attachment.ref}>
      <button type="button" disabled={!local || pending} title={local ? attachment.name : 'View this attachment in the original message'}
        aria-label={`${image ? 'Preview' : 'Download'} ${attachment.name}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-fw-border bg-fw-surface px-2 py-1 text-xs text-fw-text hover:bg-fw-hover disabled:opacity-60"
        onClick={() => { if (image) setPreview(true); else void download() }}>
        <Icon size={14} aria-hidden="true" className="shrink-0" /><span className="truncate">{attachment.name}</span>
        {!image && local && <Download size={12} aria-hidden="true" className="shrink-0" />}
      </button>
      {error && <div role="alert" className="mt-1 text-xs text-fw-warning">{error}</div>}
      {preview && <ImagePreviewDialog src={buildPathDownloadUrl(attachment.path!, { fileName: attachment.name, preview: true })} title={attachment.name} mimeType={attachment.mimeType}
        onClose={() => setPreview(false)} onDownload={() => { void download() }} downloadPending={pending} downloadError={error} />}
    </div>
  )
}

/** Safe Markdown for question text and answers; via-message records also carry attachment metadata. */
export default function QuestionContent({ text, viaMessage = false, userBubble = false }: { text: string; viaMessage?: boolean; userBubble?: boolean }) {
  const content = useMemo(() => projectQuestionContent(text, viaMessage), [text, viaMessage])
  const segments = useMemo(() => renderMarkdownSegments(content.markdown), [content.markdown])
  const userStyle = userBubble ? Object.fromEntries(['body', 'headings', 'bold', 'links', 'quotes', 'code', 'counters', 'bullets'].map(role => [`--tw-prose-${role}`, 'var(--foxwarm-color-user-text)'])) as CSSProperties : undefined
  return (
    <div data-question-content className="min-w-0">
      <div className={`foxwarm-markdown prose prose-sm dark:prose-invert max-w-none break-words [&>p]:my-1 ${userBubble ? 'foxwarm-question-user-content text-fw-user-text' : 'text-fw-text'}`} style={userStyle} onClick={handleMarkdownLinkClick}>
        {segments.map(segment => <MarkdownHtmlSegment key={segment.tokenIndex} html={segment.html} />)}
      </div>
      {content.attachments.length > 0 && <div role="list" aria-label="Answer attachments" className="mt-2 flex flex-wrap gap-2">
        {content.attachments.map(attachment => <div role="listitem" key={attachment.ref} className="min-w-0 max-w-full"><AnswerAttachment attachment={attachment} /></div>)}
      </div>}
    </div>
  )
}

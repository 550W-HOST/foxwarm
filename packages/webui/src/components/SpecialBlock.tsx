import { Check, Code, Copy, Eye } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { copyTextToClipboard, IconToggleButton } from './chatShared'
import { getMermaidSourcePolicyError } from './mermaidPolicy'
import { mermaidThemeFromSnapshot } from '../theme/integrations'
import type { ThemeRuntimeSnapshot } from '../theme/runtime'
import { useTheme } from '../theme/useTheme'

type SpecialBlockProps = {
  kind: 'latex' | 'mermaid'
  label: string
  raw: string
  children: ReactNode
}

const SpecialBlock = memo(function SpecialBlock({ kind, label, raw, children }: SpecialBlockProps) {
  const [rawVisible, setRawVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const hasVisibleHeader = kind === 'mermaid'

  useEffect(() => () => {
    if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
  }, [])

  const handleCopy = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      await copyTextToClipboard(raw)
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error(`Failed to copy ${kind} source:`, error)
    }
  }, [kind, raw])

  return (
    <section
      data-special-block
      data-special-block-kind={kind}
      className={`foxwarm-special-block not-prose group/special relative my-2 min-w-0 max-w-full overflow-hidden ${kind === 'latex' ? '' : 'rounded-md border border-fw-border bg-fw-surface-sunken/60 dark:border-fw-border dark:bg-fw-canvas/40'}`}
    >
      {hasVisibleHeader ? (
        <span data-special-block-header className="pointer-events-none absolute left-2 top-1.5 z-10 text-[10px] font-medium uppercase tracking-wide text-fw-text-muted dark:text-fw-text-muted">
          {label}
        </span>
      ) : null}
      <div data-special-block-controls className="absolute right-1 top-1 z-20 flex gap-0.5">
        <IconToggleButton onClick={() => setRawVisible(false)} active={!rawVisible} title={`Rendered ${label}`}>
          <Eye size={12} />
        </IconToggleButton>
        <IconToggleButton onClick={() => setRawVisible(true)} active={rawVisible} title={`Raw ${label}`}>
          <Code size={12} />
        </IconToggleButton>
        <IconToggleButton onClick={handleCopy} active={copied} title={copied ? 'Copied' : `Copy Raw ${label}`}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </IconToggleButton>
      </div>
      {rawVisible ? (
        <pre
          data-special-block-raw
          className="m-0 max-h-80 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono text-xs text-fw-text-strong dark:text-fw-text-strong"
        >
          {raw}
        </pre>
      ) : (
        <div data-special-block-rendered className="min-w-0 max-w-full overflow-hidden">
          {children}
        </div>
      )}
    </section>
  )
})

type MermaidRenderResult = { svg: string }

let mermaidRenderSequence = 0
let mermaidRenderQueue: Promise<void> = Promise.resolve()

const MERMAID_SECURE_CONFIG_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
  'theme', 'themeVariables', 'themeCSS', 'look', 'layout', 'handDrawnSeed', 'darkMode', 'htmlLabels',
  'fontFamily', 'altFontFamily', 'logLevel', 'deterministicIds', 'deterministicIDSeed',
  'dompurifyConfig', 'flowchart', 'swimlane', 'sequence', 'gantt', 'journey', 'timeline', 'class', 'state',
  'er', 'pie', 'quadrantChart', 'xyChart', 'requirement', 'architecture', 'mindmap', 'ishikawa', 'kanban',
  'gitGraph', 'c4', 'sankey', 'packet', 'block', 'eventmodeling', 'treeView', 'radar', 'venn', 'cynefin',
  'railroad', 'elk', 'wrap', 'fontSize', 'markdownAutoWrap', 'legacyMathML', 'forceLegacyMathML',
  'arrowMarkerAbsolute', 'titleTopMargin', 'subGraphTitleMargin',
]

const FORBIDDEN_MERMAID_SVG_ELEMENTS = new Set([
  'a', 'audio', 'embed', 'foreignobject', 'iframe', 'image', 'link', 'object', 'script', 'video',
])

const LOCAL_FRAGMENT_URL = /^['"]?#[A-Za-z_][\w:.-]*['"]?$/
const DANGEROUS_RESOURCE_PROTOCOL = /(?:javascript|vbscript|data|https?|file|blob)\s*:/i

const sanitizeSvgCssUrls = (value: string): { value: string; removed: boolean } => {
  let removed = false
  const sanitized = value.replace(/url\s*\(([^)]*)\)/gi, (match, target: string) => {
    if (LOCAL_FRAGMENT_URL.test(target.trim())) return match
    removed = true
    return 'none'
  })
  return { value: sanitized, removed }
}

export const sanitizeMermaidSvg = (svg: string): string => {
  const documentNode = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (documentNode.querySelector('parsererror') || documentNode.documentElement.localName.toLowerCase() !== 'svg') {
    throw new Error('Mermaid returned invalid SVG output.')
  }

  const root = documentNode.documentElement
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const name = element.localName.toLowerCase()
    if (FORBIDDEN_MERMAID_SVG_ELEMENTS.has(name)) {
      if (name === 'a' && element.parentNode) {
        while (element.firstChild) element.parentNode.insertBefore(element.firstChild, element)
      }
      element.remove()
      continue
    }

    if (name === 'style') {
      let css = element.textContent || ''
      css = css.replace(/@import\s+(?:url\s*\([^;]*\)|["'][^"']*["'])[^;]*;?/gi, '')
      css = sanitizeSvgCssUrls(css).value
      if (DANGEROUS_RESOURCE_PROTOCOL.test(css)) element.remove()
      else element.textContent = css
    }
  }

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const localName = attribute.localName.toLowerCase()
      if (localName.startsWith('on') || localName === 'href' || localName === 'src') {
        element.removeAttributeNode(attribute)
        continue
      }
      if (!name.startsWith('xmlns') && DANGEROUS_RESOURCE_PROTOCOL.test(attribute.value)) {
        element.removeAttributeNode(attribute)
        continue
      }
      if (/url\s*\(/i.test(attribute.value)) {
        const sanitized = sanitizeSvgCssUrls(attribute.value)
        if (sanitized.removed) element.removeAttributeNode(attribute)
        else attribute.value = sanitized.value
      }
    }
  }

  const serialized = new XMLSerializer().serializeToString(root)
  if (/<\/?(?:script|foreignObject|image|a|link)\b|\s(?:on\w+|href|xlink:href|src)\s*=/i.test(serialized)) {
    throw new Error('Mermaid returned unsupported interactive or resource-bearing SVG output.')
  }
  return serialized
}

const renderMermaid = (source: string, themeSnapshot: ThemeRuntimeSnapshot): Promise<MermaidRenderResult> => {
  const policyError = getMermaidSourcePolicyError(source)
  if (policyError) return Promise.reject(new Error(policyError))

  const task = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    const resolvedTheme = mermaidThemeFromSnapshot(themeSnapshot)
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      secure: MERMAID_SECURE_CONFIG_KEYS,
      ...resolvedTheme,
    })
    mermaidRenderSequence += 1
    return mermaid.render(`foxwarm-mermaid-${mermaidRenderSequence}`, source)
  })

  mermaidRenderQueue = task.then(() => undefined, () => undefined)
  return task
}

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setSvg('')
    setError('')

    void renderMermaid(source, theme).then((result) => {
      if (!cancelled) setSvg(sanitizeMermaidSvg(result.svg))
    }).catch((reason: unknown) => {
      if (cancelled) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.trim().slice(0, 500) || 'Unable to render this Mermaid diagram.')
    })

    return () => { cancelled = true }
  }, [source, theme.activeTheme.id, theme.effectiveMode])

  if (error) {
    return (
      <div data-mermaid-error role="alert" className="max-h-40 overflow-y-auto rounded border border-fw-warning-border bg-fw-warning-surface px-2 py-1.5 text-xs text-fw-warning dark:border-fw-warning-border dark:bg-fw-warning-surface-strong/30 dark:text-fw-warning">
        <strong className="block">Mermaid could not render this diagram.</strong>
        <span className="mt-1 block whitespace-pre-wrap break-words font-mono opacity-80">{error}</span>
      </div>
    )
  }

  if (!svg) {
    return <div data-mermaid-loading aria-busy="true" className="py-4 text-center text-xs text-fw-text-muted dark:text-fw-text-muted">Rendering diagram…</div>
  }

  return (
    <div
      data-mermaid-diagram
      className="max-w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
})

export default SpecialBlock
import { Check, Code, Copy, Eye } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { copyTextToClipboard, IconToggleButton } from './chatShared'

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
      className="foxwarm-special-block not-prose group/special relative my-2 min-w-0 max-w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/40"
    >
      <span className="pointer-events-none absolute left-2 top-1.5 z-10 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {label}
      </span>
      <div className="absolute right-1 top-1 z-20 flex gap-0.5 opacity-60 transition-opacity group-hover/special:opacity-100 focus-within:opacity-100">
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
          className="m-0 max-h-80 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-2 pb-2 pt-8 font-mono text-xs text-slate-800 dark:text-slate-200"
        >
          {raw}
        </pre>
      ) : (
        <div data-special-block-rendered className="min-w-0 max-w-full overflow-hidden px-2 pb-2 pt-8">
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

export const getMermaidSourcePolicyError = (source: string): string | null => {
  const trimmed = source.trimStart()
  if (/^---(?:\r?\n|$)/.test(trimmed)) return 'Mermaid frontmatter is disabled.'
  if (/%%\s*\{/i.test(source)) return 'Mermaid configuration directives are disabled.'
  if (/@\{[^}]*\b(?:img|link|href)\s*:/is.test(source)) return 'Mermaid image and link resources are disabled.'
  if (/(?:^|[;\r\n])\s*(?:click|href)\b/i.test(source)) return 'Interactive Mermaid links are disabled.'
  if (/\burl\s*\(/i.test(source)) return 'Mermaid CSS resources are disabled.'
  if (/(?:^|[;\r\n])\s*(?:style|classDef|linkStyle)\b/i.test(source)) return 'Custom Mermaid styling directives are disabled.'
  if (/(?:<\/?\s*(?:a|img|image|link|script|style|iframe|foreignObject)\b|@import\b)/i.test(source)) return 'Embedded Mermaid resources are disabled.'
  return null
}

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

const renderMermaid = (source: string, dark: boolean): Promise<MermaidRenderResult> => {
  const policyError = getMermaidSourcePolicyError(source)
  if (policyError) return Promise.reject(new Error(policyError))

  const task = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      htmlLabels: false,
      secure: MERMAID_SECURE_CONFIG_KEYS,
      theme: dark ? 'dark' : 'neutral',
    })
    mermaidRenderSequence += 1
    return mermaid.render(`foxwarm-mermaid-${mermaidRenderSequence}`, source)
  })

  mermaidRenderQueue = task.then(() => undefined, () => undefined)
  return task
}

const useDarkTheme = (): boolean => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const root = document.documentElement
    const syncTheme = () => setDark(root.classList.contains('dark'))
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return dark
}

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const dark = useDarkTheme()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setSvg('')
    setError('')

    void renderMermaid(source, dark).then((result) => {
      if (!cancelled) setSvg(sanitizeMermaidSvg(result.svg))
    }).catch((reason: unknown) => {
      if (cancelled) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message.trim().slice(0, 500) || 'Unable to render this Mermaid diagram.')
    })

    return () => { cancelled = true }
  }, [dark, source])

  if (error) {
    return (
      <div data-mermaid-error role="alert" className="max-h-40 overflow-y-auto rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <strong className="block">Mermaid could not render this diagram.</strong>
        <span className="mt-1 block whitespace-pre-wrap break-words font-mono opacity-80">{error}</span>
      </div>
    )
  }

  if (!svg) {
    return <div data-mermaid-loading aria-busy="true" className="py-4 text-center text-xs text-slate-500 dark:text-slate-400">Rendering diagram…</div>
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
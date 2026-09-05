import { memo, useMemo } from 'react'
import { parseAnsi } from './chatShared'
import { SyntaxHighlightedText } from './SyntaxHighlightedText'

const getHeredocFilePathFromMarker = (marker: string): string | null => {
  const normalized = marker.toLowerCase()
  if (['py', 'python', 'python3'].includes(normalized)) return 'heredoc.py'
  if (['js', 'javascript', 'node'].includes(normalized)) return 'heredoc.js'
  if (['ts', 'typescript'].includes(normalized)) return 'heredoc.ts'
  if (['sh', 'bash', 'shell', 'zsh'].includes(normalized)) return 'heredoc.sh'
  if (normalized === 'json') return 'heredoc.json'
  if (['yaml', 'yml'].includes(normalized)) return 'heredoc.yaml'
  if (['html', 'xml', 'css', 'sql', 'go', 'rs', 'rust', 'java', 'php', 'rb', 'ruby'].includes(normalized)) {
    const extension = normalized === 'rust' ? 'rs' : normalized === 'ruby' ? 'rb' : normalized
    return `heredoc.${extension}`
  }
  return null
}

const getHeredocFilePathFromCommand = (line: string, marker: string): string => {
  const markerFilePath = getHeredocFilePathFromMarker(marker)
  if (markerFilePath) return markerFilePath

  const lower = line.toLowerCase()
  if (/\bpython(?:\d+(?:\.\d+)?)?\b/.test(lower)) return 'heredoc.py'
  if (/\b(?:node|bun|deno)\b/.test(lower)) return 'heredoc.js'
  if (/\b(?:tsx|ts-node)\b/.test(lower)) return 'heredoc.ts'
  if (/\b(?:bash|sh|zsh|fish)\b/.test(lower)) return 'heredoc.sh'
  if (/\bruby\b/.test(lower)) return 'heredoc.rb'
  if (/\bphp\b/.test(lower)) return 'heredoc.php'
  if (/\b(?:psql|sqlite3?|mysql)\b/.test(lower)) return 'heredoc.sql'
  return 'heredoc.sh'
}

export const ExecCommandText = memo(function ExecCommandText({ command, heredocBodyBlock = true }: { command: string; heredocBodyBlock?: boolean }) {
  const segments = useMemo(() => {
    const lines = command.match(/[^\n]*\n|[^\n]+$/g) || (command ? [command] : [])
    const result: Array<{ text: string; filePath: string; heredocBody?: boolean }> = []
    let heredocMarker: string | null = null
    let heredocFilePath = 'heredoc.sh'

    const pushSegment = (text: string, filePath: string, options: { heredocBody?: boolean } = {}) => {
      const { heredocBody = false } = options
      const previous = result[result.length - 1]
      if (previous && previous.filePath === filePath && previous.heredocBody === heredocBody) {
        previous.text += text
      } else {
        result.push({ text, filePath, heredocBody })
      }
    }

    lines.forEach((line) => {
      if (heredocMarker) {
        if (line.trim() === heredocMarker) {
          pushSegment(line, 'command.sh')
          heredocMarker = null
          heredocFilePath = 'heredoc.sh'
          return
        }
        pushSegment(line, heredocFilePath, { heredocBody: true })
        return
      }

      const heredocMatch = line.match(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/)
      pushSegment(line, 'command.sh')
      if (heredocMatch) {
        heredocMarker = heredocMatch[1]
        heredocFilePath = getHeredocFilePathFromCommand(line, heredocMarker)
      }
    })

    return result
  }, [command])

  return (
    <>
      {segments.map((segment, idx) => segment.heredocBody && heredocBodyBlock ? (
        <div key={`${segment.filePath}-${idx}`} className="bg-fw-info-surface/80 px-2 py-1 dark:bg-fw-info-surface-strong/20">
          <SyntaxHighlightedText text={segment.text} filePath={segment.filePath} />
        </div>
      ) : segment.heredocBody ? (
        <span key={`${segment.filePath}-${idx}`} className="bg-fw-info-surface/80 px-0.5 dark:bg-fw-info-surface-strong/20">
          <SyntaxHighlightedText text={segment.text} filePath={segment.filePath} />
        </span>
      ) : (
        <SyntaxHighlightedText key={`${segment.filePath}-${idx}`} text={segment.text} filePath={segment.filePath} />
      ))}
    </>
  )
})

const hasAnsiEscape = (text: string): boolean => /\x1B\[[0-?]*[ -/]*[@-~]/.test(text)

const codeLikePathPattern = /(?:^|\s|[=:])['"]?((?:\.?\.?\/|~\/)?[\w@%+=:,./-]+(?:\.(?:tsx?|jsx?|mjs|cjs|jsonc?|css|scss|sass|less|html?|svelte|vue|mdx?|markdown|ya?ml|bash|zsh|fish|sh|pyw?|go|rs|c|cc|cpp|cxx|h|hpp|cs|java|php|rb|sql|xml|svg)|\/(?:Dockerfile|Containerfile|Makefile)|\/(?:package|tsconfig|jsconfig|composer)\.json|(?:Dockerfile|Containerfile|Makefile)|(?:package|tsconfig|jsconfig|composer)\.json))['"]?(?=$|\s|[;&|)])/gi

const extractCodeLikePaths = (text: string): string[] => {
  const paths: string[] = []
  let match: RegExpExecArray | null
  codeLikePathPattern.lastIndex = 0
  while ((match = codeLikePathPattern.exec(text)) !== null) {
    const path = match[1]
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

const inferExecOutputFilePath = (command?: string, output?: string): string | null => {
  const cmd = command || ''
  const codeReaderCommand = /\b(?:cat|sed|head|tail|nl|awk)\b/.test(cmd)
  if (codeReaderCommand) {
    const [path] = extractCodeLikePaths(cmd)
    if (path) return path
  }

  const trimmed = (output || '').trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      return 'output.json'
    } catch {
      // Not JSON; keep falling through to other lightweight heuristics.
    }
  }
  if (/^\s*(?:import|export)\s/m.test(trimmed) || /^\s*(?:const|let|var|function|class)\s+/m.test(trimmed)) return 'output.ts'
  if (/^\s*(?:def|class|from|import)\s+/m.test(trimmed)) return 'output.py'
  if (/^\s*<\/?[A-Za-z][\s\S]*>\s*$/.test(trimmed)) return 'output.html'
  return null
}

export const ExecOutputText = memo(function ExecOutputText({ text, command }: { text: string; command?: string }) {
  const filePath = useMemo(() => inferExecOutputFilePath(command, text), [command, text])
  if (!filePath || hasAnsiEscape(text)) return <>{parseAnsi(text)}</>
  return <SyntaxHighlightedText text={text} filePath={filePath} />
})

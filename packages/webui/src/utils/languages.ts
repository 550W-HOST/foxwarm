export type SimpleLanguage =
  | 'javascript'
  | 'typescript'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'yaml'
  | 'shell'
  | 'python'
  | 'dockerfile'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'csharp'
  | 'java'
  | 'php'
  | 'ruby'
  | 'sql'
  | 'xml'
  | 'plaintext'

const basename = (filePath: string) => filePath.split(/[\\/]/).pop()?.toLowerCase() || ''
const extension = (filePath: string) => {
  const name = basename(filePath)
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx) : ''
}

export function inferSimpleLanguage(filePath?: string): SimpleLanguage {
  if (!filePath) return 'plaintext'

  const name = basename(filePath)
  const ext = extension(filePath)

  if (['package.json', 'tsconfig.json', 'jsconfig.json', 'composer.json'].includes(name)) return 'json'
  if (['dockerfile', 'containerfile'].includes(name)) return 'dockerfile'
  if (['makefile'].includes(name)) return 'shell'

  switch (ext) {
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.json':
    case '.jsonc':
      return 'json'
    case '.css':
    case '.scss':
    case '.sass':
    case '.less':
      return 'css'
    case '.html':
    case '.htm':
    case '.svelte':
    case '.vue':
      return 'html'
    case '.md':
    case '.mdx':
    case '.markdown':
      return 'markdown'
    case '.yml':
    case '.yaml':
      return 'yaml'
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.fish':
    case '.env':
      return 'shell'
    case '.py':
    case '.pyw':
      return 'python'
    case '.dockerfile':
      return 'dockerfile'
    case '.go':
      return 'go'
    case '.rs':
      return 'rust'
    case '.c':
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.h':
    case '.hpp':
      return 'cpp'
    case '.cs':
      return 'csharp'
    case '.java':
      return 'java'
    case '.php':
      return 'php'
    case '.rb':
      return 'ruby'
    case '.sql':
      return 'sql'
    case '.xml':
    case '.svg':
      return 'xml'
    default:
      return 'plaintext'
  }
}

export function getMonacoLanguage(filePath?: string): string {
  const language = inferSimpleLanguage(filePath)
  switch (language) {
    case 'shell':
      return 'shell'
    case 'cpp':
      return 'cpp'
    case 'csharp':
      return 'csharp'
    case 'plaintext':
      return 'plaintext'
    default:
      return language
  }
}

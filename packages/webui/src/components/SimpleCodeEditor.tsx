import { useEffect, useRef } from 'react'

interface SimpleCodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: string
  height?: number | string
  placeholder?: string
  readOnly?: boolean
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (_workerId: string, label: string) => Worker
    }
  }
}

const currentTheme = () => document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'

export default function SimpleCodeEditor({
  value,
  onChange,
  language = 'plaintext',
  height = 280,
  placeholder,
  readOnly = false,
}: SimpleCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<any>(null)
  const modelRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const onChangeRef = useRef(onChange)

  onChangeRef.current = onChange

  useEffect(() => {
    let disposed = false
    let changeDisposable: { dispose: () => void } | null = null
    let themeObserver: MutationObserver | null = null

    const start = async () => {
      const [monaco, workerModule] = await Promise.all([
        import('monaco-editor/esm/vs/editor/editor.api.js'),
        import('monaco-editor/esm/vs/editor/editor.worker.js?worker'),
      ])
      if (disposed || !containerRef.current) return

      const EditorWorker = workerModule.default
      window.MonacoEnvironment = {
        getWorker() {
          return new EditorWorker()
        },
      }

      const model = monaco.editor.createModel(value || placeholder || '', language)
      const editor = monaco.editor.create(containerRef.current, {
        model,
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        readOnly,
        scrollBeyondLastLine: false,
        tabSize: 2,
        theme: currentTheme(),
        wordWrap: 'on',
      })

      changeDisposable = editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue())
      })

      themeObserver = new MutationObserver(() => {
        monaco.editor.setTheme(currentTheme())
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

      monacoRef.current = monaco
      editorRef.current = editor
      modelRef.current = model
    }

    void start()

    return () => {
      disposed = true
      themeObserver?.disconnect()
      changeDisposable?.dispose()
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
      monacoRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const monaco = monacoRef.current
    const model = modelRef.current
    if (!monaco || !model) return
    monaco.editor.setModelLanguage(model, language)
  }, [language])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      const position = editor.getPosition()
      editor.setValue(value)
      if (position) {
        const lineCount = editor.getModel()?.getLineCount() || 1
        editor.setPosition({ lineNumber: Math.min(position.lineNumber, lineCount), column: position.column })
      }
    }
  }, [value])

  return (
    <div
      className="overflow-hidden border border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950"
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

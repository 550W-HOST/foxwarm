import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import { getMonacoLanguage } from '../utils/languages'

interface MonacoFileEditorProps {
  value: string
  filePath?: string
  onChange: (value: string) => void
  readOnly?: boolean
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (_workerId: string, label: string) => Worker
    }
  }
}

const configureMonacoWorkers = () => {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, _label: string) {
      return new EditorWorker()
    },
  }
}

const currentTheme = () => document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'

export default function MonacoFileEditor({ value, filePath, onChange, readOnly = false }: MonacoFileEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const onChangeRef = useRef(onChange)

  onChangeRef.current = onChange

  useEffect(() => {
    configureMonacoWorkers()

    const container = containerRef.current
    if (!container) return

    const initialLanguage = getMonacoLanguage(filePath)
    const model = monaco.editor.createModel(value, initialLanguage)
    const editor = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      readOnly,
      scrollBeyondLastLine: false,
      tabSize: 2,
      theme: currentTheme(),
      wordWrap: 'off',
    })

    const changeDisposable = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })

    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(currentTheme())
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    editorRef.current = editor
    modelRef.current = model

    return () => {
      themeObserver.disconnect()
      changeDisposable.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
      modelRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    editor.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return

    const language = getMonacoLanguage(filePath)
    monaco.editor.setModelLanguage(model, language)
  }, [filePath])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    if (editor.getValue() !== value) {
      const position = editor.getPosition()
      editor.setValue(value)
      if (position) {
        const lineCount = editor.getModel()?.getLineCount() || 1
        editor.setPosition({
          lineNumber: Math.min(position.lineNumber, lineCount),
          column: position.column,
        })
      }
    }
  }, [value])

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden rounded-xl border border-gray-300 dark:border-gray-600" />
}

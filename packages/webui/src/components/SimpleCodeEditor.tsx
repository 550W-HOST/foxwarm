import { useEffect, useRef } from 'react'
import { loadYamlMonacoSupport } from '../yamlMonacoSupport'

interface SimpleCodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: string
  height?: number | string
  placeholder?: string
  readOnly?: boolean
  modelUri?: string
  focusRequest?: number
  ariaLabel?: string
}

const currentTheme = () => document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'

export default function SimpleCodeEditor({
  value,
  onChange,
  language = 'plaintext',
  height = 280,
  placeholder,
  readOnly = false,
  modelUri,
  focusRequest = 0,
  ariaLabel = 'Code editor',
}: SimpleCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<any>(null)
  const modelRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  const placeholderRef = useRef(placeholder)
  const focusRequestRef = useRef(focusRequest)

  onChangeRef.current = onChange
  valueRef.current = value
  placeholderRef.current = placeholder
  focusRequestRef.current = focusRequest

  useEffect(() => {
    let disposed = false
    let changeDisposable: { dispose: () => void } | null = null
    let markerDisposable: { dispose: () => void } | null = null
    let themeObserver: MutationObserver | null = null
    let activeModelUri = ''

    const start = async () => {
      const support = await loadYamlMonacoSupport()
      if (disposed || !containerRef.current) return
      const monaco = support.monaco
      const uri = modelUri ? monaco.Uri.parse(modelUri) : undefined
      activeModelUri = uri?.toString() || ''
      const model = monaco.editor.createModel(valueRef.current || placeholderRef.current || '', language, uri)
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

      const updateMarkerCount = () => {
        if (!wrapperRef.current) return
        wrapperRef.current.dataset.markerCount = String(monaco.editor.getModelMarkers({ resource: model.uri }).length)
      }
      markerDisposable = monaco.editor.onDidChangeMarkers((resources: readonly { toString: () => string }[]) => {
        if (resources.some((resource) => resource.toString() === model.uri.toString())) updateMarkerCount()
      })
      updateMarkerCount()

      support.updateModelSuggestions(activeModelUri, editor.getValue(), true)
      changeDisposable = editor.onDidChangeModelContent(() => {
        const nextValue = editor.getValue()
        support.updateModelSuggestions(activeModelUri, nextValue)
        onChangeRef.current(nextValue)
      })

      themeObserver = new MutationObserver(() => {
        monaco.editor.setTheme(currentTheme())
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

      monacoRef.current = monaco
      editorRef.current = editor
      modelRef.current = model
      if (focusRequestRef.current > 0) editor.focus()
      if (wrapperRef.current) wrapperRef.current.dataset.editorReady = 'true'
    }

    void start()

    return () => {
      disposed = true
      themeObserver?.disconnect()
      markerDisposable?.dispose()
      changeDisposable?.dispose()
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      if (activeModelUri) {
        void loadYamlMonacoSupport().then((support) => support.removeModelSuggestions(activeModelUri))
      }
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

  useEffect(() => {
    if (focusRequest > 0) editorRef.current?.focus()
  }, [focusRequest])

  return (
    <div
      ref={wrapperRef}
      className="overflow-hidden border border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950"
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
      data-monaco-model-uri={modelUri}
      data-editor-ready="false"
      data-marker-count="0"
      aria-label={ariaLabel}
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

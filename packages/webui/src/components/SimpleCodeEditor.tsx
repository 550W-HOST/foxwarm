import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { loadYamlMonacoSupport } from '../yamlMonacoSupport'
import { monacoThemeFromSnapshot } from '../theme/integrations'
import { getThemeSnapshot, THEME_CHANGED_EVENT } from '../theme/runtime'

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

const MONACO_THEME_ID = 'foxwarm-active'

const applyMonacoTheme = (monaco: any) => {
  monaco.editor.defineTheme(MONACO_THEME_ID, monacoThemeFromSnapshot(getThemeSnapshot()))
  monaco.editor.setTheme(MONACO_THEME_ID)
}

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
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  onChangeRef.current = onChange
  valueRef.current = value
  placeholderRef.current = placeholder
  focusRequestRef.current = focusRequest

  useEffect(() => {
    let disposed = false
    let changeDisposable: { dispose: () => void } | null = null
    let markerDisposable: { dispose: () => void } | null = null
    let removeThemeListener: (() => void) | null = null
    let activeModelUri = ''
    let inputArea: HTMLTextAreaElement | null = null
    let repairReverseSelectionInput: ((event: InputEvent) => void) | null = null

    const start = async () => {
      let support
      try {
        support = await loadYamlMonacoSupport()
      } catch (error) {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (disposed || !containerRef.current) return
      const monaco = support.monaco
      applyMonacoTheme(monaco)
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
        theme: MONACO_THEME_ID,
        wordWrap: 'on',
      })

      inputArea = editor.getDomNode()?.querySelector<HTMLTextAreaElement>('textarea.inputarea') || null
      if (inputArea) {
        repairReverseSelectionInput = (event) => {
          const selection = editor.getSelection()
          if (!event.cancelable
            || event.inputType !== 'insertText'
            || event.data === null
            || event.isComposing
            || !selection
            || selection.isEmpty()
            || selection.getDirection() !== monaco.SelectionDirection.RTL
            || inputArea?.selectionStart !== inputArea?.selectionEnd) return

          // Monaco 0.54 writes RTL selections to its Firefox textarea with reversed
          // selectionStart/selectionEnd values. Firefox collapses that invalid native range,
          // so the first input only repairs Monaco's hidden state instead of editing the model.
          // Route that desynchronized input through Monaco's normal type command instead.
          event.preventDefault()
          editor.trigger('foxwarm-reverse-selection-input', 'type', { text: event.data })
        }
        inputArea.addEventListener('beforeinput', repairReverseSelectionInput, { capture: true })
      }

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

      const syncTheme = () => applyMonacoTheme(monaco)
      window.addEventListener(THEME_CHANGED_EVENT, syncTheme)
      removeThemeListener = () => window.removeEventListener(THEME_CHANGED_EVENT, syncTheme)

      monacoRef.current = monaco
      editorRef.current = editor
      modelRef.current = model
      if (focusRequestRef.current > 0) editor.focus()
      if (wrapperRef.current) wrapperRef.current.dataset.editorReady = 'true'
    }

    void start()

    return () => {
      disposed = true
      removeThemeListener?.()
      markerDisposable?.dispose()
      changeDisposable?.dispose()
      if (inputArea && repairReverseSelectionInput) {
        inputArea.removeEventListener('beforeinput', repairReverseSelectionInput, { capture: true })
      }
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

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      // Apply the controlled replacement and its complete cursor state atomically. A separate
      // setValue/setSelections pair can leave Monaco's hidden input one update behind the visible
      // reverse selection, causing the first typed character to be consumed.
      const selections = editor.getSelections()
      const edits = [{ range: editor.getModel().getFullModelRange(), text: value, forceMoveMarkers: true }]
      if (selections) editor.executeEdits('foxwarm-controlled-value-sync', edits, selections)
      else editor.executeEdits('foxwarm-controlled-value-sync', edits)
    }
  }, [value])

  useEffect(() => {
    if (focusRequest > 0) {
      if (editorRef.current) editorRef.current.focus()
      else fallbackRef.current?.focus()
    }
  }, [focusRequest, loadError])

  if (loadError) {
    return (
      <div
        ref={wrapperRef}
        className="flex overflow-hidden border border-fw-warning-border bg-fw-surface dark:border-fw-warning-border dark:bg-fw-canvas-edge"
        style={{ height: typeof height === 'number' ? `${height}px` : height }}
        data-monaco-model-uri={modelUri}
        data-editor-ready="true"
        data-editor-fallback="true"
        data-marker-count="0"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-fw-warning-border bg-fw-warning-surface px-3 py-1.5 text-xs text-fw-warning dark:border-fw-warning-border dark:bg-fw-warning-surface-strong/40 dark:text-fw-warning">
            Advanced editor features are unavailable. You can still edit and save this YAML.
          </div>
          <textarea
            ref={fallbackRef}
            value={value}
            onChange={(event) => onChangeRef.current(event.target.value)}
            readOnly={readOnly}
            placeholder={placeholder}
            aria-label={ariaLabel}
            className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[13px] leading-5 text-fw-text-strong outline-none dark:text-fw-text-strong"
            spellCheck={false}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      ref={wrapperRef}
      className="overflow-hidden border border-fw-border-strong bg-fw-surface dark:border-fw-border dark:bg-fw-canvas-edge"
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

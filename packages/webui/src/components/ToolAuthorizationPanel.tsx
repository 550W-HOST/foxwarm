import { useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import { TOOL_AUTHORIZATION_YAML_MODEL_URI } from '../yamlConfigSchemas'
import SimpleCodeEditor from './SimpleCodeEditor'

type PolicyState = {
  exists: boolean
  yaml: string
  revision: string
  error?: string
  warnings?: string[]
}

type SaveResult = { kind: 'success' | 'error'; message: string; conflict?: boolean }

interface ToolAuthorizationPanelProps {
  active: boolean
  /** Incremented by the Setup Refresh action. */
  refreshRequest: number
}

function warningsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// Setup > Authorization: the complete global tool authorization policy in the schema-aware YAML
// editor. Every save carries the revision the text was loaded from; the server refuses it when the
// active policy changed meanwhile, and the panel then offers to reload.
export default function ToolAuthorizationPanel({ active, refreshRequest }: ToolAuthorizationPanelProps) {
  const [policy, setPolicy] = useState<PolicyState | null>(null)
  const [text, setText] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null)
  const textRef = useRef(text)
  const editRevisionRef = useRef(0)
  const baseRevisionRef = useRef<string | null>(null)
  // The text of the policy at baseRevisionRef: the editor is unedited while it still shows it.
  const loadedTextRef = useRef<string | null>(null)
  const loadGenerationRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const savingRef = useRef(false)
  textRef.current = text

  const updateText = (next: string) => {
    if (textRef.current === next) return
    textRef.current = next
    editRevisionRef.current += 1
    setText(next)
    setSaveResult((current) => (current?.conflict ? current : null))
  }

  const hydrate = (next: PolicyState) => {
    baseRevisionRef.current = next.revision
    loadedTextRef.current = next.yaml
    setPolicy(next)
    textRef.current = next.yaml
    editRevisionRef.current += 1
    setText(next.yaml)
  }

  // `replaceEdits` discards unsaved text (Reload after a refusal); otherwise only an unedited
  // editor takes the loaded policy, and edited text keeps the revision it was based on.
  const load = async (replaceEdits: boolean) => {
    const generation = ++loadGenerationRef.current
    setLoadError(null)
    try {
      const response = await fetch(`${API_BASE_PATH}/setup/authorization`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Failed to load the policy (${response.status})`)
      // A save in flight publishes the revision it installs; a refresh doesn't race it.
      if (generation !== loadGenerationRef.current || savingRef.current) return
      const next: PolicyState = {
        exists: data.exists === true,
        yaml: typeof data.yaml === 'string' ? data.yaml : '',
        revision: String(data.revision ?? ''),
        error: typeof data.error === 'string' ? data.error : undefined,
        warnings: warningsOf(data.warnings),
      }
      if (replaceEdits || baseRevisionRef.current === null || textRef.current === loadedTextRef.current) {
        saveGenerationRef.current += 1
        setSaveResult(null)
        hydrate(next)
      } else if (baseRevisionRef.current === next.revision) {
        setPolicy(next)
      }
    } catch (error) {
      if (generation === loadGenerationRef.current) setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRequest])

  const save = async () => {
    if (savingRef.current || baseRevisionRef.current === null) return
    savingRef.current = true
    const generation = ++saveGenerationRef.current
    const submittedEdit = editRevisionRef.current
    const submitted = textRef.current
    setSaving(true)
    setSaveResult(null)
    try {
      const response = await fetch(`${API_BASE_PATH}/setup/authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: submitted, revision: baseRevisionRef.current }),
      })
      const data = await response.json().catch(() => ({}))
      if (generation !== saveGenerationRef.current) return
      if (response.status === 409) {
        setSaveResult({ kind: 'error', conflict: true, message: 'This policy changed after you opened it. Reload to get the current version; your edits will be discarded.' })
        return
      }
      if (!response.ok) throw new Error(data.error || `Failed to save the policy (${response.status})`)
      baseRevisionRef.current = String(data.revision ?? '')
      loadedTextRef.current = submitted
      const warnings = warningsOf(data.warnings)
      setPolicy({ exists: true, yaml: submitted, revision: baseRevisionRef.current, warnings })
      if (editRevisionRef.current === submittedEdit && textRef.current === submitted) {
        setSaveResult({
          kind: 'success',
          message: warnings.length > 0 ? `Policy saved. ${warnings.join(' ')}` : 'Policy saved. It applies from the next tool call.',
        })
      }
    } catch (error) {
      if (generation === saveGenerationRef.current && editRevisionRef.current === submittedEdit) {
        setSaveResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleSaveShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active
      || event.key.toLowerCase() !== 's'
      || (!event.ctrlKey && !event.metaKey)
      || event.altKey
      || event.shiftKey) return
    event.preventDefault()
    if (event.repeat || event.nativeEvent.isComposing) return
    void save()
  }

  const isError = saveResult?.kind === 'error'
  return (
    <div className="foxwarm-setup-editor-section">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-fw-text-strong">Tool authorization</h2>
        <p className="mt-1 text-sm text-fw-text">Rules that decide which tools Agents and connected clients can use.</p>
        {policy && !policy.exists && (
          <p data-authorization-absent className="mt-2 text-sm text-fw-text-muted">No policy yet. Agents can use every tool their own rules allow; connected clients can’t use any.</p>
        )}
        {policy?.error && (
          <p role="alert" data-authorization-invalid className="mt-2 text-sm text-fw-danger">The saved policy is invalid, so Agents can’t respond and no tool can run until it’s fixed: {policy.error}</p>
        )}
        {loadError && <p role="alert" className="mt-2 text-sm text-fw-danger">{loadError}</p>}
      </div>

      <div className="mt-4 min-h-72 flex-1" onKeyDownCapture={handleSaveShortcut}>
        <SimpleCodeEditor value={text} onChange={updateText} language="yaml" height="100%" modelUri={TOOL_AUTHORIZATION_YAML_MODEL_URI} ariaLabel="Tool authorization YAML editor" />
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
        <button disabled={saving || !policy} onClick={() => void save()} className="rounded-lg bg-fw-accent px-4 py-2 text-sm font-medium text-fw-accent-text hover:bg-fw-accent disabled:opacity-60">{saving ? 'Saving…' : 'Save policy'}</button>
        {saveResult && (
          <div
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
            data-save-feedback="authorization"
            className={`min-w-0 basis-full whitespace-pre-wrap break-words text-sm sm:basis-auto ${isError ? 'text-fw-danger' : 'text-fw-success'}`}
          >
            {saveResult.message}
          </div>
        )}
        {saveResult?.conflict && (
          <button type="button" data-authorization-reload onClick={() => void load(true)} className="rounded-lg border border-fw-border px-3 py-1.5 text-sm font-medium text-fw-text hover:bg-fw-hover">Reload policy</button>
        )}
      </div>
    </div>
  )
}

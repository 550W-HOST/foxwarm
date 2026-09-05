import { useRef, useState } from 'react'
import { Copy, Download, Trash2, Upload } from 'lucide-react'
import { THEME_FILE_SUFFIX } from '../theme/manifest'
import { useTheme } from '../theme/useTheme'

function downloadTheme(serialized: string, name: string) {
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'foxwarm-theme'
  const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeName}${THEME_FILE_SUFFIX}`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export default function ThemeManager() {
  const theme = useTheme()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'warning' | 'success'; text: string } | null>(null)
  const [cloning, setCloning] = useState(false)
  const [cloneId, setCloneId] = useState('')
  const [cloneName, setCloneName] = useState('')

  const reportInstall = (result: ReturnType<typeof theme.installTheme>, action: string) => {
    if (!result.ok) {
      setMessage({ kind: 'error', text: result.errors.join('\n') })
      return false
    }
    setMessage(result.warnings.length > 0
      ? { kind: 'warning', text: `${action} with warnings:\n${result.warnings.join('\n')}` }
      : { kind: 'success', text: `${action}: ${result.theme.name}` })
    return true
  }

  const importTheme = async (file: File | undefined) => {
    if (!file) return
    setMessage(null)
    try {
      const serialized = await file.text()
      let result = theme.installTheme(serialized, { select: true })
      if (!result.ok && result.conflictTheme && window.confirm(`Replace installed theme “${result.conflictTheme.name}”?`)) {
        result = theme.installTheme(serialized, { replace: true, select: true })
      }
      reportInstall(result, 'Imported')
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const exportTheme = () => {
    const serialized = theme.exportTheme(theme.selection.themeId)
    if (!serialized) {
      setMessage({ kind: 'error', text: 'The selected theme could not be exported.' })
      return
    }
    downloadTheme(serialized, theme.activeTheme.name)
    setMessage({ kind: 'success', text: `Exported: ${theme.activeTheme.name}` })
  }

  const beginClone = () => {
    const slug = theme.activeTheme.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
    const ids = new Set(theme.registry.summaries.map(candidate => candidate.id))
    let suffix = 1
    let candidate = `custom.${slug}`
    while (ids.has(candidate)) candidate = `custom.${slug}-${++suffix}`
    setCloneId(candidate)
    setCloneName(`${theme.activeTheme.name} Copy`)
    setMessage(null)
    setCloning(true)
  }

  const saveClone = () => {
    const serialized = theme.exportTheme(theme.selection.themeId)
    if (!serialized) {
      setMessage({ kind: 'error', text: 'The selected theme could not be cloned.' })
      return
    }
    try {
      const manifest = JSON.parse(serialized)
      manifest.id = cloneId.trim().toLowerCase()
      manifest.name = cloneName.trim()
      const result = theme.installTheme(`${JSON.stringify(manifest)}\n`, { select: true })
      if (reportInstall(result, 'Created')) setCloning(false)
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const deleteTheme = () => {
    if (theme.selection.themeId.startsWith('foxwarm.')) return
    if (!window.confirm(`Delete theme “${theme.activeTheme.name}”?`)) return
    if (theme.removeTheme(theme.selection.themeId)) setMessage({ kind: 'success', text: 'Custom theme deleted. Default is now active.' })
    else setMessage({ kind: 'error', text: 'The selected theme could not be deleted.' })
  }

  const variant = theme.activeTheme.variants[theme.effectiveMode]
  const actionClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-fw-border bg-fw-surface px-3 py-2 text-xs font-medium text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div data-theme-manager>
      <div>
        <h2 className="text-base font-semibold text-fw-text-strong">WebUI theme</h2>
        <p className="mt-1 text-sm text-fw-text">Choose a built-in theme or manage portable <code className="font-mono text-xs">{THEME_FILE_SUFFIX}</code> files. Themes are stored only in this browser.</p>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-2">
          {theme.registry.summaries.map(option => {
            const selected = option.id === theme.selection.themeId
            return (
              <button
                key={option.id}
                type="button"
                data-theme-option={option.id}
                data-theme-surface="medium"
                onClick={() => { theme.setThemeId(option.id); setMessage(null); setCloning(false) }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition ${selected ? 'border-fw-accent-border bg-fw-accent-surface' : 'border-fw-border bg-fw-surface hover:bg-fw-hover'}`}
                aria-pressed={selected}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fw-text-strong">{option.name}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-fw-text-muted">{option.id}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${option.builtIn ? 'bg-fw-neutral-surface text-fw-text-muted' : 'bg-fw-special-surface text-fw-special'}`}>{option.builtIn ? 'Built-in' : 'Custom'}</span>
              </button>
            )
          })}
        </div>

        <aside data-theme-surface="large" className="rounded-lg border border-fw-border bg-fw-surface-sunken p-4">
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-medium text-fw-text-muted">Color mode</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-fw-border bg-fw-surface p-1" aria-label="Theme color mode">
              {(['auto', 'light', 'dark'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  data-theme-control
                  data-theme-color-mode={mode}
                  aria-pressed={theme.selection.colorMode === mode}
                  onClick={() => theme.setColorMode(mode)}
                  className={`rounded-md px-2 py-1.5 text-[11px] font-medium capitalize transition ${theme.selection.colorMode === mode ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-1.5" aria-label={`${theme.activeTheme.name} color preview`}>
            {[variant.colors.canvas, variant.colors.surface, variant.colors.textStrong, variant.colors.accent, variant.colors.success, variant.colors.warning, variant.colors.danger, variant.colors.special].map((color, index) => (
              <span key={`${color}-${index}`} className="h-7 min-w-0 flex-1 rounded border border-fw-border" style={{ backgroundColor: color }} />
            ))}
          </div>
          <h3 className="mt-3 text-sm font-semibold text-fw-text-strong">{theme.activeTheme.name}</h3>
          <p className="mt-1 text-xs leading-5 text-fw-text-muted">{theme.activeTheme.description || 'No description.'}</p>
          <div className="mt-1 font-mono text-[10px] text-fw-text-subtle">Schema v{theme.activeTheme.schemaVersion} · {theme.effectiveMode} preview</div>
          <input ref={fileInputRef} type="file" accept=".json,.foxwarm-theme.json,application/json" className="hidden" onChange={event => { void importTheme(event.currentTarget.files?.[0]) }} />
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" data-theme-control onClick={() => fileInputRef.current?.click()} className={actionClass}><Upload className="h-3.5 w-3.5" /> Import</button>
            <button type="button" data-theme-control onClick={exportTheme} className={actionClass}><Download className="h-3.5 w-3.5" /> Export</button>
            <button type="button" data-theme-control onClick={beginClone} className={actionClass}><Copy className="h-3.5 w-3.5" /> Clone</button>
            <button type="button" data-theme-control onClick={deleteTheme} disabled={theme.selection.themeId.startsWith('foxwarm.')} className={`${actionClass} border-fw-danger-border text-fw-danger hover:bg-fw-danger-surface`}><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </div>
        </aside>
      </div>

      {cloning && (
        <div data-theme-surface="large" className="mt-4 max-w-xl rounded-lg border border-fw-border bg-fw-surface-sunken p-4">
          <h3 className="text-sm font-semibold text-fw-text-strong">Clone selected theme</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-fw-text-muted">Name<input data-theme-control value={cloneName} onChange={event => setCloneName(event.currentTarget.value)} className="mt-1 block w-full rounded-lg border border-fw-border bg-fw-input px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border" aria-label="Cloned theme name" /></label>
            <label className="text-xs font-medium text-fw-text-muted">Immutable ID<input data-theme-control value={cloneId} onChange={event => setCloneId(event.currentTarget.value)} className="mt-1 block w-full rounded-lg border border-fw-border bg-fw-input px-3 py-2 font-mono text-xs text-fw-text-strong outline-none focus:border-fw-accent-border" aria-label="Cloned theme ID" /></label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" data-theme-control onClick={() => setCloning(false)} className="rounded-lg px-3 py-2 text-xs font-medium text-fw-text-muted hover:bg-fw-hover">Cancel</button>
            <button type="button" data-theme-control onClick={saveClone} className="rounded-lg bg-fw-accent px-3 py-2 text-xs font-medium text-fw-text-inverse hover:bg-fw-accent-muted">Create theme</button>
          </div>
        </div>
      )}

      {message && (
        <div role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-4 whitespace-pre-wrap rounded-lg border px-3 py-2 text-xs ${message.kind === 'error' ? 'border-fw-danger-border bg-fw-danger-surface text-fw-danger' : message.kind === 'warning' ? 'border-fw-warning-border bg-fw-warning-surface text-fw-warning' : 'border-fw-success-border bg-fw-success-surface text-fw-success'}`}>
          {message.text}
        </div>
      )}
    </div>
  )
}

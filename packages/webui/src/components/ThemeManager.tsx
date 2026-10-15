import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Download, Trash2, Upload, Sun, Moon, Check, X, Expand } from 'lucide-react'
import { THEME_FILE_SUFFIX, themeVariantCssVariables, type ThemeVariant } from '../theme/manifest'
import { useTheme } from '../theme/useTheme'
import ThemeWorkbenchPreview from './ThemeWorkbenchPreview'

function downloadTheme(serialized: string, name: string) {
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'foxwarm-theme'
  const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeName}${THEME_FILE_SUFFIX}`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ThemePreview({ variant }: { variant: ThemeVariant }) {
  return <span className="theme-card-preview theme-thumb" aria-hidden="true" style={themeVariantCssVariables(variant) as CSSProperties}>
    <span className="theme-thumb-sidebar">
      <span className="theme-thumb-brand"><i /><b /></span>
      <span className="theme-thumb-nav"><i /><b /></span>
      <span className="theme-thumb-nav theme-thumb-nav-selected"><i /><b /></span>
      <span className="theme-thumb-nav"><i /><b /></span>
      <span className="theme-thumb-sidebar-rule" />
      <span className="theme-thumb-session"><i /><b /></span>
      <span className="theme-thumb-session"><i /><b /></span>
    </span>
    <span className="theme-thumb-workspace">
      <span className="theme-thumb-tabs"><i /><b /><b /></span>
      <span className="theme-thumb-chat">
        <span className="theme-thumb-user"><i /><i /></span>
        <span className="theme-thumb-assistant"><i /><i /><i /></span>
        <span className="theme-thumb-tool"><b /><span><i /><i /></span></span>
      </span>
      <span className="theme-thumb-composer"><i /><span><i /><b /></span></span>
      <span className="theme-thumb-status"><i /><i /></span>
    </span>
  </span>
}

export default function ThemeManager() {
  const theme = useTheme()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'warning' | 'success'; text: string } | null>(null)
  const [preview, setPreview] = useState<{ id: string; mode: 'light' | 'dark' } | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const previewTheme = preview ? theme.registry.themes.find(candidate => candidate.id === preview.id) : undefined
  const closePreview = () => { setPreview(null) }

  useEffect(() => {
    if (preview && !previewTheme) setPreview(null)
  }, [preview, previewTheme])

  useEffect(() => {
    if (!preview) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const modal = modalRef.current
    const root = modal?.parentElement
    const siblings = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root)
    const previousInert = siblings.map(element => element.inert)
    siblings.forEach(element => { element.inert = true })
    modal?.querySelector<HTMLButtonElement>('[data-theme-preview-close]')?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPreview(null); return }
      if (event.key !== 'Tab' || !modal) return
      const controls = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]')]
      const first = controls[0], last = controls[controls.length - 1]
      if (!first || !last) { event.preventDefault(); modal.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      siblings.forEach((element, index) => { element.inert = previousInert[index] })
      document.removeEventListener('keydown', keydown, true)
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true })
      else document.querySelector<HTMLButtonElement>('[data-theme-color-mode]')?.focus({ preventScroll: true })
    }
  }, [!!preview])

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
      let result = theme.installTheme(serialized)
      if (!result.ok && result.conflictTheme && window.confirm(`Replace installed theme “${result.conflictTheme.name}”?`)) {
        result = theme.installTheme(serialized, { replace: true })
      }
      if (reportInstall(result, 'Imported') && result.ok) setPreview({ id: result.theme.id, mode: theme.effectiveMode })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const exportTheme = () => {
    if (!previewTheme) return
    const serialized = theme.exportTheme(previewTheme.id)
    if (!serialized) { setMessage({ kind: 'error', text: 'The theme could not be exported.' }); return }
    downloadTheme(serialized, previewTheme.name)
  }

  const deleteTheme = () => {
    if (!previewTheme || previewTheme.id.startsWith('foxwarm.')) return
    if (!window.confirm(`Delete theme “${previewTheme.name}”?`)) return
    if (theme.removeTheme(previewTheme.id)) { closePreview(); setMessage({ kind: 'success', text: 'Custom theme deleted.' }) }
    else setMessage({ kind: 'error', text: 'The theme could not be deleted.' })
  }

  const applyTheme = (mode: 'light' | 'dark') => {
    if (!previewTheme) return
    theme.setThemeForMode(mode, previewTheme.id)
    closePreview()
    setMessage(null)
  }

  const actionClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-fw-border bg-fw-surface px-3 py-2 text-xs font-medium text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-40'

  const modes: Array<'light' | 'dark'> = theme.selection.colorMode === 'auto' ? ['light', 'dark'] : [theme.effectiveMode]

  return (
    <div data-theme-manager className="theme-manager">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-fw-text-strong">Appearance</h2>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-fw-border bg-fw-surface p-1" aria-label="Theme color mode">
            {(['auto', 'light', 'dark'] as const).map(mode => <button key={mode} type="button" data-theme-control data-theme-color-mode={mode} aria-pressed={theme.selection.colorMode === mode}
              onClick={() => { theme.setColorMode(mode); setMessage(null) }}
              className={`rounded-md px-3 py-1.5 text-xs capitalize ${theme.selection.colorMode === mode ? 'bg-fw-selected text-fw-accent' : 'text-fw-text-muted hover:bg-fw-hover'}`}>{mode}</button>)}
          </div>
          <button type="button" data-theme-control onClick={event => { openerRef.current = event.currentTarget; fileInputRef.current?.click() }} className={actionClass}><Upload className="h-3.5 w-3.5" />Import</button>
        </div>
      </div>
      <input ref={fileInputRef} type="file" accept=".json,.foxwarm-theme.json,application/json" className="hidden" onChange={event => { void importTheme(event.currentTarget.files?.[0]) }} />
      <div className={`theme-choice-columns mt-5 ${modes.length === 2 ? 'theme-choice-paired' : ''}`}>
        {modes.map(mode => {
          const storedChoiceId = mode === 'light' ? theme.selection.lightThemeId : theme.selection.darkThemeId
          const choiceId = theme.registry.themes.some(option => option.id === storedChoiceId) ? storedChoiceId : 'foxwarm.default'
          const ModeIcon = mode === 'light' ? Sun : Moon
          return <section key={mode} data-theme-mode-panel={mode} aria-label={`${mode === 'light' ? 'Light' : 'Dark'} theme`}>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fw-text-strong"><ModeIcon className="h-4 w-4 text-fw-text-muted" /><h3>{mode === 'light' ? 'Light theme' : 'Dark theme'}</h3>{theme.effectiveMode === mode && <span className="ml-auto text-[11px] font-normal text-fw-text-muted">Active</span>}</div>
            <div className="theme-card-grid">
              {theme.registry.themes.map(option => {
                const selected = option.id === choiceId
                return <div key={option.id} className={`theme-option-card relative ${selected ? 'border-fw-accent-border bg-fw-accent-surface' : 'border-fw-border bg-fw-surface hover:bg-fw-hover'}`}>
                  <button type="button" data-theme-option={option.id} data-theme-option-mode={mode} data-theme-surface="medium" aria-pressed={selected} aria-label={`Use ${option.name} for ${mode === 'light' ? 'Light' : 'Dark'}`}
                    onClick={() => { theme.setThemeForMode(mode, option.id); setMessage(null) }} className="theme-option-select w-full text-left">
                    <ThemePreview variant={option.variants[mode]} />
                    <span className="flex min-w-0 items-center gap-2 px-2 py-2.5"><span className="min-w-0 flex-1 truncate text-sm font-medium text-fw-text-strong">{option.name}</span>{!option.id.startsWith('foxwarm.') && <span className="text-[10px] text-fw-text-muted">Custom</span>}{selected && <Check className="h-4 w-4 shrink-0 text-fw-accent" aria-hidden="true" />}</span>
                  </button>
                  <button type="button" data-theme-preview={option.id} data-theme-preview-mode={mode} title="Preview theme" aria-label={`Preview ${option.name} · ${mode === 'light' ? 'Light' : 'Dark'}`}
                    onClick={event => { openerRef.current = event.currentTarget; setPreview({ id: option.id, mode }); setMessage(null) }} className="theme-preview-open"><Expand className="h-3.5 w-3.5" aria-hidden="true" /></button>
                </div>
              })}
            </div>
          </section>
        })}
      </div>
      {preview && previewTheme && createPortal(
        <div className="theme-preview-backdrop" data-theme-preview-backdrop onPointerDown={event => { if (event.target === event.currentTarget) closePreview() }}>
          <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-theme-preview-dialog className="theme-preview-dialog">
            <header className="flex shrink-0 items-center gap-3 border-b border-fw-border px-5 py-4">
              <div className="min-w-0 flex-1"><h2 id={titleId} className="truncate text-base font-semibold text-fw-text-strong">{previewTheme.name}</h2><span className="text-xs text-fw-text-muted">{previewTheme.id.startsWith('foxwarm.') ? 'Built-in' : 'Custom'}</span></div>
              <button type="button" data-theme-preview-close aria-label="Close theme preview" onClick={closePreview} className="rounded p-2 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong"><X className="h-4 w-4" /></button>
            </header>
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <div className="mb-3 flex justify-center gap-1" aria-label="Preview color mode">
                {(['light', 'dark'] as const).map(mode => { const Icon = mode === 'light' ? Sun : Moon; return <button key={mode} type="button" aria-pressed={preview.mode === mode} aria-label={`Preview ${mode}`} onClick={() => setPreview({ ...preview, mode })} className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs capitalize ${preview.mode === mode ? 'bg-fw-selected text-fw-accent' : 'text-fw-text-muted hover:bg-fw-hover'}`}><Icon className="h-3.5 w-3.5" />{mode}</button> })}
              </div>
              <ThemeWorkbenchPreview variant={previewTheme.variants[preview.mode]} />
            </div>
            <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-fw-border px-5 py-4">
              <button type="button" aria-label="Export theme" onClick={exportTheme} className={actionClass}><Download className="h-3.5 w-3.5" />Export</button>
              {!previewTheme.id.startsWith('foxwarm.') && <button type="button" aria-label="Delete theme" onClick={deleteTheme} className={`${actionClass} border-fw-danger-border text-fw-danger hover:bg-fw-danger-surface`}><Trash2 className="h-3.5 w-3.5" />Delete</button>}
              <div className="ml-auto flex flex-wrap gap-2">
                {(['light', 'dark'] as const).map(mode => {
                  const selected = (mode === 'light' ? theme.selection.lightThemeId : theme.selection.darkThemeId) === previewTheme.id
                  const Icon = selected ? Check : mode === 'light' ? Sun : Moon
                  return <button key={mode} type="button" aria-label={`Use for ${mode}`} disabled={selected} onClick={() => applyTheme(mode)} className={`inline-flex items-center gap-1.5 rounded border px-3 py-2 text-xs font-medium ${selected ? 'border-fw-border text-fw-text-muted' : preview.mode === mode ? 'border-fw-accent bg-fw-accent text-fw-accent-text hover:bg-fw-accent-muted' : 'border-fw-border bg-fw-surface text-fw-text hover:bg-fw-hover'}`}><Icon className="h-3.5 w-3.5" />{selected ? `${mode === 'light' ? 'Light' : 'Dark'} selected` : `Use for ${mode === 'light' ? 'Light' : 'Dark'}`}</button>
                })}
              </div>
            </footer>
          </div>
        </div>, document.body)}
      {theme.registry.errors.length > 0 && <div role="alert" className="mt-4 text-xs text-fw-warning">{theme.registry.errors.join('\n')}</div>}
      {message && <div role={message.kind === 'error' ? 'alert' : 'status'} className={`mt-4 whitespace-pre-wrap rounded-lg border px-3 py-2 text-xs ${message.kind === 'error' ? 'border-fw-danger-border bg-fw-danger-surface text-fw-danger' : message.kind === 'warning' ? 'border-fw-warning-border bg-fw-warning-surface text-fw-warning' : 'border-fw-success-border bg-fw-success-surface text-fw-success'}`}>{message.text}</div>}
    </div>
  )
}

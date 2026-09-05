import { DEFAULT_THEME_ID } from './builtins'
import { themeVariantCssVariables, type ResolvedThemeMode, type ThemeColorMode, type ThemeManifestV1 } from './manifest'
import {
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_SELECTION_STORAGE_KEY,
  deleteCustomTheme,
  exportThemeById,
  installThemeFromJson,
  readThemeRegistry,
  readThemeSelection,
  writeThemeSelection,
  type InstallThemeResult,
  type ThemeRegistrySnapshot,
  type ThemeSelection,
} from './storage'

export const THEME_CHANGED_EVENT = 'foxwarm-theme-changed'

export type ThemeRuntimeSnapshot = {
  selection: ThemeSelection
  effectiveMode: ResolvedThemeMode
  activeTheme: ThemeManifestV1
  registry: ThemeRegistrySnapshot
  systemPrefersDark: boolean
}

const listeners = new Set<() => void>()
let initialized = false
let mediaQuery: MediaQueryList | null = null
let snapshot: ThemeRuntimeSnapshot | null = null

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

function resolveSnapshot(): ThemeRuntimeSnapshot {
  const storage = browserStorage()
  const registry = readThemeRegistry(storage)
  let selection = readThemeSelection(storage)
  let activeTheme = registry.themes.find(theme => theme.id === selection.themeId)
  if (!activeTheme) {
    selection = { ...selection, themeId: DEFAULT_THEME_ID }
    writeThemeSelection(storage, selection)
    activeTheme = registry.themes.find(theme => theme.id === DEFAULT_THEME_ID)!
  }
  const systemPrefersDark = mediaQuery?.matches
    ?? (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  const effectiveMode: ResolvedThemeMode = selection.colorMode === 'auto'
    ? (systemPrefersDark ? 'dark' : 'light')
    : selection.colorMode
  return { selection, effectiveMode, activeTheme, registry, systemPrefersDark }
}

function applySnapshot(next: ThemeRuntimeSnapshot): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const variant = next.activeTheme.variants[next.effectiveMode]
  const variables = themeVariantCssVariables(variant)
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
  root.style.setProperty('--foxwarm-app-background', variant.colors.canvas)
  root.style.setProperty('--foxwarm-scrollbar-track', variant.colors.scrollbarTrack)
  root.style.setProperty('--foxwarm-scrollbar-thumb', variant.colors.scrollbarThumb)
  root.style.setProperty('--foxwarm-scrollbar-thumb-hover', variant.colors.scrollbarThumbHover)
  root.style.colorScheme = next.effectiveMode
  root.classList.toggle('dark', next.effectiveMode === 'dark')
  root.dataset.foxwarmTheme = next.activeTheme.id
  root.dataset.foxwarmThemeMode = next.effectiveMode
  root.dataset.foxwarmComponentTreatment = variant.componentTreatment

  // Compatibility variables consumed by the existing console-treatment CSS.
  // Their values are derived exclusively from the public semantic manifest;
  // there is no built-in theme ID branch, so an exported/reimported console
  // theme receives the same rendering path while the old names are retired.
  const consoleVariables: Record<string, string> = {
    '--foxwarm-console-font': variant.typography.uiFontFamily,
    '--foxwarm-console-code-font-family': variant.typography.codeFontFamily,
    '--foxwarm-console-message-font': variant.typography.messageFontFamily,
    '--foxwarm-console-font-ui': `${variant.typography.uiFontSizePx}px`,
    '--foxwarm-console-font-ui-small': `${variant.typography.smallFontSizePx}px`,
    '--foxwarm-console-font-control': `${variant.typography.controlFontSizePx}px`,
    '--foxwarm-console-font-message': `${variant.typography.messageFontSizePx}px`,
    '--foxwarm-console-font-composer': `${variant.typography.composerFontSizePx}px`,
    '--foxwarm-console-font-code': `${variant.typography.codeFontSizePx}px`,
    '--foxwarm-console-line-ui': String(variant.typography.uiLineHeight),
    '--foxwarm-console-line-message': String(variant.typography.messageLineHeight),
    '--foxwarm-console-line-code': String(variant.typography.codeLineHeight),
    '--foxwarm-console-accent': variant.colors.accent,
    '--foxwarm-console-accent-dim': variant.colors.accentMuted,
    '--foxwarm-console-accent-glow': `rgb(var(--foxwarm-color-accent-rgb) / ${variant.effects.glowOpacity})`,
    '--foxwarm-console-accent-wash': 'rgb(var(--foxwarm-color-accent-rgb) / 0.1)',
    '--foxwarm-console-accent-wash-strong': 'rgb(var(--foxwarm-color-accent-rgb) / 0.16)',
    '--foxwarm-console-bg': variant.colors.canvas,
    '--foxwarm-console-bg-edge': variant.colors.canvasEdge,
    '--foxwarm-console-panel': variant.colors.surface,
    '--foxwarm-console-input': variant.colors.input,
    '--foxwarm-console-hover': variant.colors.hover,
    '--foxwarm-console-border': variant.colors.borderMuted,
    '--foxwarm-console-border-panel': variant.colors.border,
    '--foxwarm-console-border-hover': variant.colors.borderStrong,
    '--foxwarm-console-text': variant.colors.text,
    '--foxwarm-console-text-dim': variant.colors.textSubtle,
    '--foxwarm-console-text-bright': variant.colors.textStrong,
    '--foxwarm-console-green': variant.colors.success,
    '--foxwarm-console-green-dim': variant.colors.success,
    '--foxwarm-console-green-border': variant.colors.successBorder,
    '--foxwarm-console-green-surface': variant.colors.successSurface,
    '--foxwarm-console-green-surface-strong': variant.colors.successSurfaceStrong,
    '--foxwarm-console-green-glow': `color-mix(in srgb, ${variant.colors.success} ${variant.effects.glowOpacity * 100}%, transparent)`,
    '--foxwarm-console-green-deep': variant.colors.successBorder,
    '--foxwarm-console-green-deep-hover': variant.colors.success,
    '--foxwarm-console-green-button-idle': variant.colors.successSurface,
    '--foxwarm-console-green-button-idle-hover': variant.colors.successSurfaceStrong,
    '--foxwarm-console-green-button-active-text': variant.colors.textInverse,
    '--foxwarm-console-orange': variant.colors.warning,
    '--foxwarm-console-orange-border': variant.colors.warningBorder,
    '--foxwarm-console-orange-surface': variant.colors.warningSurface,
    '--foxwarm-console-orange-surface-strong': variant.colors.warningSurfaceStrong,
    '--foxwarm-console-diff-removed-surface': variant.colors.diffRemovedSurface,
    '--foxwarm-console-diff-removed-surface-strong': variant.colors.diffRemovedSurfaceStrong,
    '--foxwarm-console-diff-added-surface': variant.colors.diffAddedSurface,
    '--foxwarm-console-diff-added-surface-strong': variant.colors.diffAddedSurfaceStrong,
    '--foxwarm-console-blue': variant.colors.systemAccent,
    '--foxwarm-console-blue-dim': variant.colors.systemAccent,
    '--foxwarm-console-blue-border': variant.colors.systemBorder,
    '--foxwarm-console-blue-surface': variant.colors.systemSurface,
    '--foxwarm-console-blue-surface-strong': variant.colors.systemSurfaceStrong,
    '--foxwarm-console-blue-glow': `color-mix(in srgb, ${variant.colors.systemAccent} ${variant.effects.glowOpacity * 100}%, transparent)`,
    '--foxwarm-console-fail': variant.colors.special,
    '--foxwarm-console-fail-border': variant.colors.specialBorder,
    '--foxwarm-console-fail-deep': variant.colors.specialBorder,
    '--foxwarm-console-fail-deep-hover': variant.colors.special,
    '--foxwarm-console-fail-button-idle': variant.colors.specialSurface,
    '--foxwarm-console-fail-button-idle-hover': variant.colors.specialSurface,
    '--foxwarm-console-fail-button-active-text': variant.colors.textInverse,
    '--foxwarm-console-fail-glow': `color-mix(in srgb, ${variant.colors.special} ${variant.effects.glowOpacity * 100}%, transparent)`,
    '--foxwarm-console-radius': `${variant.shape.radiusSmallPx}px`,
    '--foxwarm-console-radius-medium': `${variant.shape.radiusMediumPx}px`,
    '--foxwarm-console-radius-large': `${variant.shape.radiusLargePx}px`,
    '--foxwarm-console-grid-background': `var(--foxwarm-background-image), linear-gradient(${variant.colors.canvas}, ${variant.colors.canvas})`,
  }
  for (const [name, value] of Object.entries(consoleVariables)) root.style.setProperty(name, value)

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', variant.colors.canvas)
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, {
    detail: { themeId: next.activeTheme.id, mode: next.effectiveMode },
  }))
}

function refresh({ notify = true }: { notify?: boolean } = {}): ThemeRuntimeSnapshot {
  const next = resolveSnapshot()
  snapshot = next
  applySnapshot(next)
  if (notify) for (const listener of listeners) listener()
  return next
}

export function initializeThemeRuntime(): ThemeRuntimeSnapshot {
  if (initialized && snapshot) return snapshot
  initialized = true
  if (typeof window !== 'undefined') {
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null
    const handleMedia = () => refresh()
    mediaQuery?.addEventListener?.('change', handleMedia)
    window.addEventListener('storage', event => {
      if (event.key === THEME_SELECTION_STORAGE_KEY || event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) {
        refresh()
      }
    })
  }
  return refresh({ notify: false })
}

export function getThemeSnapshot(): ThemeRuntimeSnapshot {
  return snapshot || initializeThemeRuntime()
}

export function subscribeThemeRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setThemeSelection(update: Partial<Pick<ThemeSelection, 'themeId' | 'colorMode'>>): ThemeRuntimeSnapshot {
  const current = getThemeSnapshot()
  const themeId = update.themeId ?? current.selection.themeId
  const colorMode = update.colorMode ?? current.selection.colorMode
  if (!current.registry.themes.some(theme => theme.id === themeId)) {
    throw new Error(`Theme ${themeId} is not installed`)
  }
  if (!(['auto', 'light', 'dark'] as ThemeColorMode[]).includes(colorMode)) {
    throw new Error(`Color mode ${colorMode} is not supported`)
  }
  const selection: ThemeSelection = { version: 1, themeId, colorMode }
  if (!writeThemeSelection(browserStorage(), selection)) {
    throw new Error('Theme selection could not be persisted')
  }
  return refresh()
}

export function installTheme(serialized: string, options: { replace?: boolean; select?: boolean } = {}): InstallThemeResult {
  const result = installThemeFromJson(browserStorage(), serialized, options)
  if (!result.ok) return result
  refresh()
  if (options.select) setThemeSelection({ themeId: result.theme.id })
  return result
}

export function removeTheme(themeId: string): boolean {
  const current = getThemeSnapshot()
  const deleted = deleteCustomTheme(browserStorage(), themeId)
  if (!deleted) return false
  if (current.selection.themeId === themeId) {
    writeThemeSelection(browserStorage(), { ...current.selection, themeId: DEFAULT_THEME_ID })
  }
  refresh()
  return true
}

export function exportTheme(themeId: string): string | null {
  return exportThemeById(browserStorage(), themeId)
}

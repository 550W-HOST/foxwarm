import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './builtins'
import {
  parseThemeManifestJson,
  serializeThemeManifest,
  validateThemeManifest,
  type ThemeColorMode,
  type ThemeManifest,
} from './manifest'

export const THEME_SELECTION_STORAGE_KEY = 'foxwarm_theme_selection_v2'
export const LEGACY_THEME_SELECTION_STORAGE_KEY = 'foxwarm_theme_selection_v1'
export const CUSTOM_THEMES_STORAGE_KEY = 'foxwarm_custom_themes_v2'
export const LEGACY_COLOR_MODE_STORAGE_KEY = 'themeMode'
export const LEGACY_THEME_STYLE_STORAGE_KEY = 'foxwarm_ui_theme_style_v1'
export const MAX_CUSTOM_THEMES = 32

export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type ThemeSelection = { version: 2; themeId: string; colorMode: ThemeColorMode }
export type ThemeSummary = { id: string; name: string; description?: string; author?: string; builtIn: boolean }
export type ThemeRegistrySnapshot = {
  themes: readonly ThemeManifest[]
  summaries: readonly ThemeSummary[]
  customThemes: readonly ThemeManifest[]
  errors: readonly string[]
}

type StoredCustomThemes = { version: 2; themes: ThemeManifest[] }

const COLOR_MODES = new Set<ThemeColorMode>(['auto', 'light', 'dark'])

function safeGet(storage: ThemeStorage | null | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null } catch { return null }
}

function safeSet(storage: ThemeStorage | null | undefined, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value)
    return !!storage
  } catch {
    return false
  }
}

function normalizeSelection(value: unknown): ThemeSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 2 || typeof raw.themeId !== 'string' || !COLOR_MODES.has(raw.colorMode as ThemeColorMode)) return null
  return { version: 2, themeId: raw.themeId, colorMode: raw.colorMode as ThemeColorMode }
}

export function readThemeSelection(storage: ThemeStorage | null | undefined): ThemeSelection {
  const stored = safeGet(storage, THEME_SELECTION_STORAGE_KEY)
  if (stored) {
    try {
      const normalized = normalizeSelection(JSON.parse(stored))
      if (normalized) return normalized
    } catch {}
  }

  // V2 isolates current selection writes from older live WebUI bundles. Those
  // bundles listen to and may rewrite the V1 key when they encounter a newer
  // built-in ID that is absent from their compiled registry.
  const previousSelection = safeGet(storage, LEGACY_THEME_SELECTION_STORAGE_KEY)
  if (previousSelection) {
    try {
      const raw = JSON.parse(previousSelection) as Record<string, unknown>
      if (raw.version === 1 && typeof raw.themeId === 'string' && COLOR_MODES.has(raw.colorMode as ThemeColorMode)) {
        const migrated: ThemeSelection = { version: 2, themeId: raw.themeId, colorMode: raw.colorMode as ThemeColorMode }
        safeSet(storage, THEME_SELECTION_STORAGE_KEY, JSON.stringify(migrated))
        return migrated
      }
    } catch {}
  }

  const legacyMode = safeGet(storage, LEGACY_COLOR_MODE_STORAGE_KEY)
  const colorMode: ThemeColorMode = COLOR_MODES.has(legacyMode as ThemeColorMode)
    ? legacyMode as ThemeColorMode
    : 'auto'
  const legacyStyle = safeGet(storage, LEGACY_THEME_STYLE_STORAGE_KEY)
  const selection: ThemeSelection = {
    version: 2,
    themeId: legacyStyle === '550a' ? 'foxwarm.550a' : DEFAULT_THEME_ID,
    colorMode,
  }
  safeSet(storage, THEME_SELECTION_STORAGE_KEY, JSON.stringify(selection))
  return selection
}

export function writeThemeSelection(storage: ThemeStorage | null | undefined, selection: ThemeSelection): boolean {
  const normalized = normalizeSelection(selection)
  if (!normalized) return false
  return safeSet(storage, THEME_SELECTION_STORAGE_KEY, JSON.stringify(normalized))
}

function readStoredCustomThemes(storage: ThemeStorage | null | undefined): { themes: ThemeManifest[]; errors: string[] } {
  const serialized = safeGet(storage, CUSTOM_THEMES_STORAGE_KEY)
  if (!serialized) return { themes: [], errors: [] }
  try {
    const raw = JSON.parse(serialized) as { version?: unknown; themes?: unknown }
    if (raw.version !== 2 || !Array.isArray(raw.themes)) {
      return { themes: [], errors: ['custom theme storage has an unsupported shape'] }
    }
    const themes: ThemeManifest[] = []
    const errors: string[] = []
    const ids = new Set<string>()
    for (const [index, candidate] of raw.themes.slice(0, MAX_CUSTOM_THEMES).entries()) {
      const result = validateThemeManifest(candidate)
      if (!result.ok) {
        errors.push(`custom theme ${index + 1}: ${result.errors.join('; ')}`)
        continue
      }
      if (result.value.id.startsWith('foxwarm.')) {
        errors.push(`custom theme ${result.value.id} uses the reserved foxwarm.* namespace`)
        continue
      }
      if (ids.has(result.value.id)) {
        errors.push(`custom theme ${result.value.id} is duplicated`)
        continue
      }
      ids.add(result.value.id)
      themes.push(result.value)
    }
    if (raw.themes.length > MAX_CUSTOM_THEMES) errors.push(`only the first ${MAX_CUSTOM_THEMES} custom themes were loaded`)
    return { themes, errors }
  } catch (error) {
    return { themes: [], errors: [`custom theme storage is invalid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

function writeCustomThemes(storage: ThemeStorage | null | undefined, themes: readonly ThemeManifest[]): boolean {
  if (themes.length > MAX_CUSTOM_THEMES) return false
  const payload: StoredCustomThemes = { version: 2, themes: [...themes] }
  return safeSet(storage, CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(payload))
}

export function readThemeRegistry(storage: ThemeStorage | null | undefined): ThemeRegistrySnapshot {
  const custom = readStoredCustomThemes(storage)
  const themes = [...BUILTIN_THEMES, ...custom.themes]
  return {
    themes,
    customThemes: custom.themes,
    errors: custom.errors,
    summaries: themes.map(theme => ({
      id: theme.id,
      name: theme.name,
      ...(theme.description ? { description: theme.description } : {}),
      ...(theme.author ? { author: theme.author } : {}),
      builtIn: theme.id.startsWith('foxwarm.'),
    })),
  }
}

export type InstallThemeResult =
  | { ok: true; theme: ThemeManifest; replaced: boolean; warnings: string[] }
  | { ok: false; errors: string[]; conflictTheme?: ThemeManifest }

export function installThemeFromJson(
  storage: ThemeStorage | null | undefined,
  serialized: string,
  options: { replace?: boolean } = {},
): InstallThemeResult {
  const parsed = parseThemeManifestJson(serialized)
  if (!parsed.ok) return parsed
  if (parsed.value.id.startsWith('foxwarm.')) {
    return { ok: false, errors: ['foxwarm.* is reserved for built-in themes'] }
  }
  const registry = readThemeRegistry(storage)
  const existing = registry.customThemes.find(theme => theme.id === parsed.value.id)
  if (existing && !options.replace) {
    return { ok: false, errors: [`theme ${parsed.value.id} is already installed`], conflictTheme: existing }
  }
  const themes = existing
    ? registry.customThemes.map(theme => theme.id === parsed.value.id ? parsed.value : theme)
    : [...registry.customThemes, parsed.value]
  if (themes.length > MAX_CUSTOM_THEMES) {
    return { ok: false, errors: [`only ${MAX_CUSTOM_THEMES} custom themes may be installed`] }
  }
  if (!writeCustomThemes(storage, themes)) {
    return { ok: false, errors: ['custom themes could not be persisted'] }
  }
  return { ok: true, theme: parsed.value, replaced: !!existing, warnings: parsed.warnings }
}

export function deleteCustomTheme(storage: ThemeStorage | null | undefined, themeId: string): boolean {
  if (themeId.startsWith('foxwarm.')) return false
  const registry = readThemeRegistry(storage)
  if (!registry.customThemes.some(theme => theme.id === themeId)) return false
  return writeCustomThemes(storage, registry.customThemes.filter(theme => theme.id !== themeId))
}

export function exportThemeById(storage: ThemeStorage | null | undefined, themeId: string): string | null {
  const theme = readThemeRegistry(storage).themes.find(candidate => candidate.id === themeId)
  return theme ? serializeThemeManifest(theme) : null
}

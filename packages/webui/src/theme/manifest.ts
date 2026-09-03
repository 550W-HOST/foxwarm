export const THEME_SCHEMA_VERSION = 1 as const
export const THEME_FILE_SUFFIX = '.foxwarm-theme.json'
export const THEME_MAX_FILE_BYTES = 64 * 1024

export const THEME_COLOR_KEYS = [
  'canvas', 'canvasEdge', 'surface', 'surfaceRaised', 'surfaceSunken', 'input', 'overlay',
  'hover', 'selected', 'borderMuted', 'border', 'borderStrong', 'text', 'textMuted',
  'textSubtle', 'textStrong', 'textInverse', 'accent', 'accentMuted', 'accentSurface',
  'accentSurfaceStrong', 'accentBorder', 'focusRing', 'neutral', 'neutralSurface',
  'neutralBorder', 'info', 'infoSurface', 'infoSurfaceStrong', 'infoBorder', 'success',
  'successSurface', 'successSurfaceStrong', 'successBorder', 'warning', 'warningSurface',
  'warningSurfaceStrong', 'warningBorder', 'danger', 'dangerSurface', 'dangerSurfaceStrong',
  'dangerBorder', 'special', 'specialSurface', 'specialBorder', 'userSurface', 'userText',
  'assistantSurface', 'assistantText', 'threadText', 'reasoningSurface', 'reasoningSurfaceStrong',
  'systemSurface', 'systemSurfaceStrong', 'systemText', 'systemAccent', 'systemBorder', 'codeSurface',
  'codeText', 'assistantCodeSurface', 'assistantCodeText', 'inlineCodeSurface', 'inlineCodeText', 'diffAddedSurface',
  'diffAddedSurfaceStrong', 'diffRemovedSurface', 'diffRemovedSurfaceStrong',
  'scrollbarTrack', 'scrollbarThumb', 'scrollbarThumbHover', 'contextViewport', 'terminalBackground',
  'terminalForeground', 'terminalCursor', 'terminalSelection',
] as const

export const THEME_TYPOGRAPHY_STRING_KEYS = ['uiFontFamily', 'messageFontFamily', 'codeFontFamily'] as const
export const THEME_TYPOGRAPHY_NUMBER_KEYS = [
  'uiFontSizePx', 'smallFontSizePx', 'controlFontSizePx', 'messageFontSizePx',
  'composerFontSizePx', 'codeFontSizePx', 'uiLineHeight', 'messageLineHeight', 'codeLineHeight',
] as const
export const THEME_SHAPE_KEYS = [
  'radiusSmallPx', 'radiusMediumPx', 'radiusLargePx', 'borderWidthPx', 'controlHeightPx',
] as const
export const THEME_EFFECT_NUMBER_KEYS = [
  'shadowOpacity', 'shadowBlurPx', 'glowOpacity', 'pressOffsetPx', 'transitionMs',
] as const

export type ThemeColorKey = typeof THEME_COLOR_KEYS[number]
export type ThemeTypographyStringKey = typeof THEME_TYPOGRAPHY_STRING_KEYS[number]
export type ThemeTypographyNumberKey = typeof THEME_TYPOGRAPHY_NUMBER_KEYS[number]
export type ThemeShapeKey = typeof THEME_SHAPE_KEYS[number]
export type ThemeEffectNumberKey = typeof THEME_EFFECT_NUMBER_KEYS[number]

export type ThemeColorMode = 'auto' | 'light' | 'dark'
export type ResolvedThemeMode = Exclude<ThemeColorMode, 'auto'>

export type ThemeBackgroundPattern =
  | { kind: 'none' }
  | { kind: 'grid'; sizePx: number; opacity: number }

export type ThemeVariant = {
  componentTreatment: 'standard' | 'console'
  colors: Record<ThemeColorKey, string>
  typography: Record<ThemeTypographyStringKey, string> & Record<ThemeTypographyNumberKey, number>
  shape: Record<ThemeShapeKey, number>
  effects: { shadowColor: string } & Record<ThemeEffectNumberKey, number>
  backgroundPattern: ThemeBackgroundPattern
}

export type ThemeManifestV1 = {
  schemaVersion: typeof THEME_SCHEMA_VERSION
  id: string
  name: string
  description?: string
  author?: string
  variants: {
    light: ThemeVariant
    dark: ThemeVariant
  }
}

export type ThemeValidationResult =
  | { ok: true; value: ThemeManifestV1; warnings: string[] }
  | { ok: false; errors: string[] }

const ROOT_KEYS = new Set(['schemaVersion', 'id', 'name', 'description', 'author', 'variants'])
const VARIANT_KEYS = new Set(['componentTreatment', 'colors', 'typography', 'shape', 'effects', 'backgroundPattern'])
const EFFECT_KEYS = new Set(['shadowColor', ...THEME_EFFECT_NUMBER_KEYS])
const PATTERN_KEYS = new Set(['kind', 'sizePx', 'opacity'])
const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i
const THEME_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not supported`)
  }
}

function normalizeText(
  value: unknown,
  path: string,
  errors: string[],
  { min = 0, max = 500 }: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`)
    return ''
  }
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    errors.push(`${path} must contain between ${min} and ${max} characters`)
  }
  if (/\p{Cc}/u.test(normalized)) errors.push(`${path} must not contain control characters`)
  return normalized
}

function normalizeColor(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    errors.push(`${path} must be a six- or eight-digit hexadecimal color`)
    return '#000000'
  }
  return value.toLowerCase()
}

function normalizeNumber(value: unknown, path: string, errors: string[], min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${path} must be a finite number between ${min} and ${max}`)
    return min
  }
  return value
}

function normalizeFontFamily(value: unknown, path: string, errors: string[]): string {
  const normalized = normalizeText(value, path, errors, { min: 1, max: 512 })
  if (/[{};@]|url\s*\(/i.test(normalized)) {
    errors.push(`${path} contains unsupported CSS syntax`)
  }
  return normalized
}

function normalizeRequiredRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
  path: string,
  errors: string[],
  normalize: (item: unknown, itemPath: string, errors: string[]) => string | number,
): Record<T, any> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return Object.fromEntries(keys.map(key => [key, normalize(undefined, `${path}.${key}`, errors)])) as Record<T, any>
  }
  rejectUnknownKeys(value, new Set(keys), path, errors)
  return Object.fromEntries(keys.map(key => [key, normalize(value[key], `${path}.${key}`, errors)])) as Record<T, any>
}

const TYPOGRAPHY_NUMBER_RANGES: Record<ThemeTypographyNumberKey, readonly [number, number]> = {
  uiFontSizePx: [10, 24],
  smallFontSizePx: [9, 22],
  controlFontSizePx: [10, 24],
  messageFontSizePx: [11, 28],
  composerFontSizePx: [12, 30],
  codeFontSizePx: [9, 24],
  uiLineHeight: [1, 2.5],
  messageLineHeight: [1, 2.5],
  codeLineHeight: [1, 2.5],
}

const SHAPE_RANGES: Record<ThemeShapeKey, readonly [number, number]> = {
  radiusSmallPx: [0, 24],
  radiusMediumPx: [0, 32],
  radiusLargePx: [0, 48],
  borderWidthPx: [0, 4],
  controlHeightPx: [24, 64],
}

const EFFECT_RANGES: Record<ThemeEffectNumberKey, readonly [number, number]> = {
  shadowOpacity: [0, 1],
  shadowBlurPx: [0, 64],
  glowOpacity: [0, 1],
  pressOffsetPx: [0, 4],
  transitionMs: [0, 1000],
}

function normalizeVariant(value: unknown, path: string, errors: string[]): ThemeVariant {
  const raw = isRecord(value) ? value : {}
  if (!isRecord(value)) errors.push(`${path} must be an object`)
  rejectUnknownKeys(raw, VARIANT_KEYS, path, errors)
  const componentTreatment = raw.componentTreatment === 'standard' || raw.componentTreatment === 'console'
    ? raw.componentTreatment
    : 'standard'
  if (raw.componentTreatment !== 'standard' && raw.componentTreatment !== 'console') {
    errors.push(`${path}.componentTreatment must be standard or console`)
  }

  const colors = normalizeRequiredRecord(raw.colors, THEME_COLOR_KEYS, `${path}.colors`, errors, normalizeColor)
  const typographyStrings = normalizeRequiredRecord(
    raw.typography,
    THEME_TYPOGRAPHY_STRING_KEYS,
    `${path}.typography`,
    [],
    normalizeFontFamily,
  )
  const typographyRaw = isRecord(raw.typography) ? raw.typography : {}
  if (isRecord(raw.typography)) {
    rejectUnknownKeys(
      typographyRaw,
      new Set([...THEME_TYPOGRAPHY_STRING_KEYS, ...THEME_TYPOGRAPHY_NUMBER_KEYS]),
      `${path}.typography`,
      errors,
    )
  }
  const typographyNumbers = Object.fromEntries(THEME_TYPOGRAPHY_NUMBER_KEYS.map(key => {
    const [min, max] = TYPOGRAPHY_NUMBER_RANGES[key]
    return [key, normalizeNumber(typographyRaw[key], `${path}.typography.${key}`, errors, min, max)]
  })) as Record<ThemeTypographyNumberKey, number>
  // The first pass validates only the string subset. Replay any errors against
  // the caller's accumulator after avoiding duplicate unknown-key findings.
  for (const key of THEME_TYPOGRAPHY_STRING_KEYS) {
    typographyStrings[key] = normalizeFontFamily(typographyRaw[key], `${path}.typography.${key}`, errors)
  }

  const shapeRaw = isRecord(raw.shape) ? raw.shape : {}
  if (!isRecord(raw.shape)) errors.push(`${path}.shape must be an object`)
  rejectUnknownKeys(shapeRaw, new Set(THEME_SHAPE_KEYS), `${path}.shape`, errors)
  const shape = Object.fromEntries(THEME_SHAPE_KEYS.map(key => {
    const [min, max] = SHAPE_RANGES[key]
    return [key, normalizeNumber(shapeRaw[key], `${path}.shape.${key}`, errors, min, max)]
  })) as Record<ThemeShapeKey, number>

  const effectsRaw = isRecord(raw.effects) ? raw.effects : {}
  if (!isRecord(raw.effects)) errors.push(`${path}.effects must be an object`)
  rejectUnknownKeys(effectsRaw, EFFECT_KEYS, `${path}.effects`, errors)
  const effects = {
    shadowColor: normalizeColor(effectsRaw.shadowColor, `${path}.effects.shadowColor`, errors),
    ...Object.fromEntries(THEME_EFFECT_NUMBER_KEYS.map(key => {
      const [min, max] = EFFECT_RANGES[key]
      return [key, normalizeNumber(effectsRaw[key], `${path}.effects.${key}`, errors, min, max)]
    })) as Record<ThemeEffectNumberKey, number>,
  }

  const patternRaw = isRecord(raw.backgroundPattern) ? raw.backgroundPattern : {}
  if (!isRecord(raw.backgroundPattern)) errors.push(`${path}.backgroundPattern must be an object`)
  rejectUnknownKeys(patternRaw, PATTERN_KEYS, `${path}.backgroundPattern`, errors)
  let backgroundPattern: ThemeBackgroundPattern
  if (patternRaw.kind === 'none') {
    backgroundPattern = { kind: 'none' }
    if ('sizePx' in patternRaw || 'opacity' in patternRaw) {
      errors.push(`${path}.backgroundPattern must not include grid settings when kind is none`)
    }
  } else if (patternRaw.kind === 'grid') {
    backgroundPattern = {
      kind: 'grid',
      sizePx: normalizeNumber(patternRaw.sizePx, `${path}.backgroundPattern.sizePx`, errors, 4, 128),
      opacity: normalizeNumber(patternRaw.opacity, `${path}.backgroundPattern.opacity`, errors, 0, 0.25),
    }
  } else {
    errors.push(`${path}.backgroundPattern.kind must be none or grid`)
    backgroundPattern = { kind: 'none' }
  }

  return {
    componentTreatment,
    colors,
    typography: { ...typographyStrings, ...typographyNumbers },
    shape,
    effects,
    backgroundPattern,
  }
}

export function validateThemeManifest(value: unknown): ThemeValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['theme must be an object'] }
  rejectUnknownKeys(value, ROOT_KEYS, 'theme', errors)
  if (value.schemaVersion !== THEME_SCHEMA_VERSION) {
    errors.push(`theme.schemaVersion must be ${THEME_SCHEMA_VERSION}`)
  }
  const id = normalizeText(value.id, 'theme.id', errors, { min: 3, max: 64 }).toLowerCase()
  if (!THEME_ID.test(id)) errors.push('theme.id must use lowercase letters, numbers, dots, underscores, or hyphens')
  const name = normalizeText(value.name, 'theme.name', errors, { min: 1, max: 80 })
  const description = value.description === undefined
    ? undefined
    : normalizeText(value.description, 'theme.description', errors, { max: 500 })
  const author = value.author === undefined
    ? undefined
    : normalizeText(value.author, 'theme.author', errors, { max: 80 })
  const variantsRaw = isRecord(value.variants) ? value.variants : {}
  if (!isRecord(value.variants)) errors.push('theme.variants must be an object')
  rejectUnknownKeys(variantsRaw, new Set(['light', 'dark']), 'theme.variants', errors)
  const light = normalizeVariant(variantsRaw.light, 'theme.variants.light', errors)
  const dark = normalizeVariant(variantsRaw.dark, 'theme.variants.dark', errors)

  if (errors.length > 0) return { ok: false, errors }
  const normalized: ThemeManifestV1 = {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    variants: { light, dark },
  }
  const warnings: string[] = []
  for (const mode of ['light', 'dark'] as const) {
    const colors = normalized.variants[mode].colors
    for (const [foreground, background, label, threshold] of [
      [colors.text, colors.surface, 'text on surface', 4.5],
      [colors.textStrong, colors.canvas, 'strong text on canvas', 4.5],
      [colors.surface, colors.textStrong, 'surface text on strong fill', 4.5],
      [colors.textInverse, colors.accent, 'inverse text on accent', 3],
    ] as const) {
      const ratio = colorContrastRatio(foreground, background)
      if (ratio < threshold) warnings.push(`${mode} ${label} contrast is ${ratio.toFixed(2)}:1 (recommended: ${threshold.toFixed(1)}:1)`)
    }
  }
  return {
    ok: true,
    warnings,
    value: normalized,
  }
}

function colorContrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function parseThemeManifestJson(text: string): ThemeValidationResult {
  if (new TextEncoder().encode(text).byteLength > THEME_MAX_FILE_BYTES) {
    return { ok: false, errors: [`theme file exceeds ${THEME_MAX_FILE_BYTES} bytes`] }
  }
  try {
    return validateThemeManifest(JSON.parse(text))
  } catch (error) {
    return { ok: false, errors: [`theme is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export function serializeThemeManifest(manifest: ThemeManifestV1): string {
  const result = validateThemeManifest(manifest)
  if (!result.ok) throw new Error(`Cannot serialize invalid theme: ${result.errors.join('; ')}`)
  return `${JSON.stringify(result.value, null, 2)}\n`
}

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
}

function hexColorChannels(value: string): string {
  const hex = value.slice(1, 7)
  return `${parseInt(hex.slice(0, 2), 16)} ${parseInt(hex.slice(2, 4), 16)} ${parseInt(hex.slice(4, 6), 16)}`
}

export function themeVariantCssVariables(variant: ThemeVariant): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    const name = `--foxwarm-color-${toKebab(key)}`
    variables[name] = variant.colors[key]
    variables[`${name}-rgb`] = hexColorChannels(variant.colors[key])
  }
  for (const key of THEME_TYPOGRAPHY_STRING_KEYS) variables[`--foxwarm-${toKebab(key)}`] = variant.typography[key]
  for (const key of THEME_TYPOGRAPHY_NUMBER_KEYS) {
    const suffix = key.endsWith('Px') ? 'px' : ''
    variables[`--foxwarm-${toKebab(key)}`] = `${variant.typography[key]}${suffix}`
  }
  for (const key of THEME_SHAPE_KEYS) variables[`--foxwarm-${toKebab(key)}`] = `${variant.shape[key]}px`
  variables['--foxwarm-shadow-color'] = variant.effects.shadowColor
  variables['--foxwarm-panel-shadow'] = `0 4px ${variant.effects.shadowBlurPx}px color-mix(in srgb, ${variant.effects.shadowColor} ${variant.effects.shadowOpacity * 100}%, transparent)`
  variables['--foxwarm-accent-glow'] = `0 0 ${variant.effects.shadowBlurPx}px color-mix(in srgb, ${variant.colors.accent} ${variant.effects.glowOpacity * 100}%, transparent)`
  variables['--foxwarm-press-transform'] = `translateY(${variant.effects.pressOffsetPx}px)`
  for (const key of THEME_EFFECT_NUMBER_KEYS) {
    const suffix = key.endsWith('Px') ? 'px' : key.endsWith('Ms') ? 'ms' : ''
    variables[`--foxwarm-${toKebab(key)}`] = `${variant.effects[key]}${suffix}`
  }
  variables['--foxwarm-background-image'] = variant.backgroundPattern.kind === 'grid'
    ? `linear-gradient(rgb(${hexColorChannels(variant.colors.accent)} / ${variant.backgroundPattern.opacity}) 1px, transparent 1px), linear-gradient(90deg, rgb(${hexColorChannels(variant.colors.accent)} / ${variant.backgroundPattern.opacity}) 1px, transparent 1px)`
    : 'none'
  variables['--foxwarm-background-size'] = variant.backgroundPattern.kind === 'grid'
    ? `${variant.backgroundPattern.sizePx}px ${variant.backgroundPattern.sizePx}px`
    : 'auto'
  return variables
}
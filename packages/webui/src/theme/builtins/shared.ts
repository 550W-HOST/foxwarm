import type { ThemeManifest, ThemeVariant } from '../manifest'
import { validateThemeManifest } from '../manifest'

export const SYSTEM_FONT = "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
export const MONO_FONT = "'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'Noto Sans Mono CJK SC', 'Sarasa Mono SC', monospace"

type VariantInput = {
  componentTreatment?: ThemeVariant['componentTreatment']
  colors: ThemeVariant['colors']
  typography?: Partial<ThemeVariant['typography']>
  shape?: Partial<ThemeVariant['shape']>
  effects?: Partial<ThemeVariant['effects']>
  composition?: Partial<ThemeVariant['composition']>
  backgroundPattern?: ThemeVariant['backgroundPattern']
}

type VariantOverrides = Partial<Omit<VariantInput, 'colors'>> & {
  colors: Partial<ThemeVariant['colors']>
}

export function variant(input: VariantInput): ThemeVariant {
  return {
    componentTreatment: input.componentTreatment || 'standard',
    colors: input.colors,
    typography: {
      uiFontFamily: SYSTEM_FONT,
      messageFontFamily: SYSTEM_FONT,
      codeFontFamily: MONO_FONT,
      uiFontSizePx: 14,
      smallFontSizePx: 12,
      controlFontSizePx: 14,
      messageFontSizePx: 16,
      composerFontSizePx: 16,
      codeFontSizePx: 13,
      uiLineHeight: 1.5,
      messageLineHeight: 1.625,
      codeLineHeight: 1.5,
      ...input.typography,
    },
    shape: {
      radiusSmallPx: 4,
      radiusMediumPx: 8,
      radiusLargePx: 16,
      messageRadiusPx: 8,
      cardRadiusPx: 0,
      controlRadiusPx: 4,
      tagRadiusPx: 6,
      composerRadiusPx: 30,
      cardGapPx: 2,
      cardInsetPx: 8,
      borderWidthPx: 1,
      controlHeightPx: 36,
      ...input.shape,
    },
    effects: {
      shadowColor: '#000000',
      shadowOpacity: 0.18,
      shadowBlurPx: 12,
      glowOpacity: 0,
      pressOffsetPx: 0,
      transitionMs: 150,
      ...input.effects,
    },
    composition: {
      density: 'comfortable',
      card: 'flat',
      header: 'banded',
      control: 'soft',
      separator: 'rail',
      labels: 'uppercase',
      icons: 'standard',
      ...input.composition,
    },
    backgroundPattern: input.backgroundPattern || { kind: 'none' },
  }
}

/** Build a complete built-in variant while keeping the semantic token set explicit at the registry boundary. */
export function derivedVariant(base: ThemeVariant, overrides: VariantOverrides): ThemeVariant {
  return variant({
    componentTreatment: overrides.componentTreatment || base.componentTreatment,
    colors: { ...base.colors, ...overrides.colors },
    typography: { ...base.typography, ...overrides.typography },
    shape: { ...base.shape, ...overrides.shape },
    effects: { ...base.effects, ...overrides.effects },
    composition: { ...base.composition, ...overrides.composition },
    backgroundPattern: overrides.backgroundPattern || base.backgroundPattern,
  })
}

export function checkedBuiltin(manifest: ThemeManifest): ThemeManifest {
  const result = validateThemeManifest(manifest)
  if (!result.ok) throw new Error(`Invalid built-in theme ${manifest.id}: ${result.errors.join('; ')}`)
  return result.value
}

import type { ThemeVariant } from '../manifest'
import { checkedBuiltin, MONO_FONT, SYSTEM_FONT, variant } from './shared'

export const THEME_550A_MONO_ID = 'foxwarm.550a-mono'

const consoleTypography: Partial<ThemeVariant['typography']> = {
  uiFontFamily: SYSTEM_FONT,
  messageFontFamily: SYSTEM_FONT,
  codeFontFamily: MONO_FONT,
  uiFontSizePx: 13,
  smallFontSizePx: 11.5,
  controlFontSizePx: 12.5,
  messageFontSizePx: 15,
  composerFontSizePx: 16,
  codeFontSizePx: 12.5,
  uiLineHeight: 1.45,
  messageLineHeight: 1.65,
  codeLineHeight: 1.55,
}

const consoleShape: Partial<ThemeVariant['shape']> = {
  radiusSmallPx: 2,
  radiusMediumPx: 4,
  radiusLargePx: 6,
  messageRadiusPx: 6,
  cardRadiusPx: 0,
  controlRadiusPx: 3,
  tagRadiusPx: 2,
  composerRadiusPx: 6,
  cardGapPx: 3,
  cardInsetPx: 6,
  borderWidthPx: 1,
  controlHeightPx: 32,
}

const consoleEffects: Partial<ThemeVariant['effects']> = {
  shadowColor: '#000000',
  shadowOpacity: 0.18,
  shadowBlurPx: 8,
  glowOpacity: 0.18,
  pressOffsetPx: 1,
  transitionMs: 150,
}

const consoleLight = variant({
  componentTreatment: 'console',
  composition: { density: 'compact', card: 'flat', header: 'plate', control: 'plain', separator: 'rail', labels: 'uppercase', icons: 'compact' },
  colors: {
    canvas: '#dcdfde', canvasEdge: '#c9cdcb', surface: '#f0f2f1', surfaceRaised: '#fafbf9',
    surfaceSunken: '#d1d5d3', input: '#e5e8e6', overlay: '#16201d66', hover: '#e1e4e3',
    selected: '#ead5d5', borderMuted: '#c1c6c3', border: '#9ca39f', borderStrong: '#6c7470',
    text: '#3d4441', textMuted: '#69716d', textSubtle: '#8b928f', textStrong: '#191e1c',
    textInverse: '#ffffff', accent: '#d22f34', accentMuted: '#a92a2e', accentSurface: '#f2dcdd',
    accentSurfaceStrong: '#e8c2c3', accentBorder: '#bd696b', focusRing: '#d22f34', neutral: '#606865',
    neutralSurface: '#e1e4e3', neutralBorder: '#a5aca8', info: '#58615d', infoSurface: '#e1e4e3',
    infoSurfaceStrong: '#d0d5d3', infoBorder: '#9aa29f', success: '#58615d', successSurface: '#e1e4e3',
    successSurfaceStrong: '#d0d5d3', successBorder: '#9aa29f', tool: '#4d5652', toolSurface: '#e1e4e3', toolSurfaceStrong: '#d0d5d3', toolBorder: '#929a96', warning: '#9a651f', warningSurface: '#eee1c9',
    warningSurfaceStrong: '#e3c999', warningBorder: '#bea16c', danger: '#a9433f', dangerSurface: '#eed9d6',
    dangerSurfaceStrong: '#e3beb9', dangerBorder: '#bd7a74', special: '#665b60', specialSurface: '#e6e1e3',
    specialBorder: '#aaa0a4', userSurface: '#3c4743', userText: '#f4f6f4', assistantSurface: '#edf1ee',
    assistantText: '#17211e', threadText: '#394340', reasoningSurface: '#e6e8e7', reasoningSurfaceStrong: '#d7dad8',
    systemSurface: '#e1e4e3', systemSurfaceStrong: '#d0d5d3', systemText: '#414845', systemAccent: '#58615d', systemBorder: '#9aa29f', codeSurface: '#d4dbd7',
    codeText: '#17211e', assistantCodeSurface: '#d4dbd7', assistantCodeText: '#17211e', inlineCodeSurface: '#cbd3cf', inlineCodeText: '#17211e',
    diffAddedSurface: '#e1e4e3', diffAddedSurfaceStrong: '#d0d5d3', diffAddedText: '#4d5652', diffRemovedText: '#93423d', syntaxComment: '#718079', syntaxString: '#8a662f', syntaxNumber: '#a92a2e', syntaxKeyword: '#a92a2e', syntaxLiteral: '#6c7470', syntaxHeading: '#17211e', syntaxTag: '#a9433f', syntaxAttribute: '#9a651f', syntaxProperty: '#4d5652', diffRemovedSurface: '#eed9d6',
    diffRemovedSurfaceStrong: '#e3beb9', scrollbarTrack: '#d1d5d3', scrollbarThumb: '#9ca39f',
    scrollbarThumbHover: '#6c7470', contextViewport: '#d22f34', terminalBackground: '#17211e', terminalForeground: '#dcdfde',
    terminalCursor: '#ef3f44', terminalSelection: '#d22f3444',
  },
  typography: consoleTypography,
  shape: consoleShape,
  effects: consoleEffects,
  backgroundPattern: { kind: 'none' },
  displayEffect: { kind: 'none' },
})

const consoleDark = variant({
  componentTreatment: 'console',
  composition: { density: 'compact', card: 'flat', header: 'plate', control: 'plain', separator: 'rail', labels: 'uppercase', icons: 'compact' },
  colors: {
    canvas: '#121414', canvasEdge: '#090b0a', surface: '#1b1e1d', surfaceRaised: '#242826',
    surfaceSunken: '#0d0f0e', input: '#141716', overlay: '#000000b3', hover: '#272b29',
    selected: '#382326', borderMuted: '#2b302e', border: '#414844', borderStrong: '#626b67',
    text: '#b5bcb8', textMuted: '#878f8b', textSubtle: '#626965', textStrong: '#e3e7e5',
    textInverse: '#ffffff', accent: '#f04449', accentMuted: '#bc3439', accentSurface: '#321719',
    accentSurfaceStrong: '#492023', accentBorder: '#763137', focusRing: '#f04449', neutral: '#a1a9a5',
    neutralSurface: '#242826', neutralBorder: '#555e5a', info: '#abb3af', infoSurface: '#202423',
    infoSurfaceStrong: '#2d3331', infoBorder: '#505b57', success: '#abb3af', successSurface: '#202423',
    successSurfaceStrong: '#2d3331', successBorder: '#505b57', tool: '#b7bfbb', toolSurface: '#202423', toolSurfaceStrong: '#2d3331', toolBorder: '#59625e', warning: '#d0a05a', warningSurface: '#312510',
    warningSurfaceStrong: '#4b3919', warningBorder: '#755a2c', danger: '#dc7168', dangerSurface: '#351817',
    dangerSurfaceStrong: '#512321', dangerBorder: '#7b3935', special: '#c0afb6', specialSurface: '#2b2427',
    specialBorder: '#62545a', userSurface: '#2b3532', userText: '#eef2ef', assistantSurface: '#1b1e1d',
    assistantText: '#e3e7e5', threadText: '#b5bcb8', reasoningSurface: '#202321', reasoningSurfaceStrong: '#2b302e',
    systemSurface: '#202423', systemSurfaceStrong: '#2d3331', systemText: '#c3c9c6', systemAccent: '#abb3af', systemBorder: '#505b57', codeSurface: '#0c110f',
    codeText: '#dbe2de', assistantCodeSurface: '#0c110f', assistantCodeText: '#dbe2de', inlineCodeSurface: '#222a27', inlineCodeText: '#dbe2de',
    diffAddedSurface: '#202423', diffAddedSurfaceStrong: '#2d3331', diffAddedText: '#c3c9c6', diffRemovedText: '#e08a82', syntaxComment: '#6d7a74', syntaxString: '#d0a05a', syntaxNumber: '#f04449', syntaxKeyword: '#e2797d', syntaxLiteral: '#b5bcb8', syntaxHeading: '#e1e6e3', syntaxTag: '#dc7168', syntaxAttribute: '#d0a05a', syntaxProperty: '#c3c9c6', diffRemovedSurface: '#351817',
    diffRemovedSurfaceStrong: '#512321', scrollbarTrack: '#0d0f0e', scrollbarThumb: '#414844',
    scrollbarThumbHover: '#626b67', contextViewport: '#f04449', terminalBackground: '#0c110f', terminalForeground: '#dce1de',
    terminalCursor: '#f04449', terminalSelection: '#f0444944',
  },
  typography: consoleTypography,
  shape: consoleShape,
  effects: consoleEffects,
  backgroundPattern: { kind: 'none' },
  displayEffect: {
    kind: 'crt', mask: 'none', bezel: 'inset', scanPitchPx: 5, scanOpacity: 0.11,
    maskPitchPx: 4, maskOpacity: 0, bloomPx: 0.8, bloomOpacity: 0.14,
    vignetteOpacity: 0.11, reflectionOpacity: 0.025, rollOpacity: 0.035,
    rollDurationSec: 18, glassRadiusPx: 4,
  },
})

export const THEME_550A_MONO = checkedBuiltin({
  schemaVersion: 2,
  id: THEME_550A_MONO_ID,
  name: '550A Mono',
  description: 'A restrained machine-console theme inspired by pale industrial housings, modular panels, and a single red sensor beacon.',
  author: 'Foxwarm',
  variants: { light: consoleLight, dark: consoleDark },
})

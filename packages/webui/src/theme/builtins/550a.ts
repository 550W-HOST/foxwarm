import type { ThemeVariant } from '../manifest'
import { checkedBuiltin, MONO_FONT, variant } from './shared'

export const THEME_550A_ID = 'foxwarm.550a'

const consoleTypography: Partial<ThemeVariant['typography']> = {
  uiFontFamily: MONO_FONT,
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
  radiusSmallPx: 3,
  radiusMediumPx: 3,
  radiusLargePx: 3,
  borderWidthPx: 1,
  controlHeightPx: 32,
}

const consoleEffects: Partial<ThemeVariant['effects']> = {
  shadowColor: '#000000',
  shadowOpacity: 0.3,
  shadowBlurPx: 8,
  glowOpacity: 0.3,
  pressOffsetPx: 1,
  transitionMs: 150,
}

const consoleLight = variant({
  componentTreatment: 'console',
  colors: {
    canvas: '#f4f3ef', canvasEdge: '#edece7', surface: '#ffffff', surfaceRaised: '#ffffff',
    surfaceSunken: '#fafaf8', input: '#fafaf8', overlay: '#00000066', hover: '#eeeeea',
    selected: '#f5dede', borderMuted: '#e8e4dc', border: '#dddddd', borderStrong: '#bbbbbb',
    text: '#444444', textMuted: '#777777', textSubtle: '#999999', textStrong: '#222222',
    textInverse: '#ffffff', accent: '#cc3333', accentMuted: '#aa3333', accentSurface: '#f9eaea',
    accentSurfaceStrong: '#f4d8d8', accentBorder: '#d9a8a8', focusRing: '#cc3333', neutral: '#777777',
    neutralSurface: '#eeeeea', neutralBorder: '#cccccc', info: '#4f7f99', infoSurface: '#edf4f7',
    infoSurfaceStrong: '#dceaf0', infoBorder: '#b7ccd8', success: '#3a7a3a', successSurface: '#f0f8f0',
    successSurfaceStrong: '#e0f0e0', successBorder: '#c0e0c0', warning: '#a8652a', warningSurface: '#faeedc',
    warningSurfaceStrong: '#f4d8b4', warningBorder: '#dec3a3', danger: '#a8652a', dangerSurface: '#faeedc',
    dangerSurfaceStrong: '#f4d8b4', dangerBorder: '#dec3a3', special: '#7052b8', specialSurface: '#f0ecfa',
    specialBorder: '#cfc2eb', userSurface: '#cc3333', userText: '#ffffff', assistantSurface: '#ffffff',
    assistantText: '#222222', threadText: '#444444', reasoningSurface: '#ffffff', reasoningSurfaceStrong: '#eeeeea',
    systemSurface: '#edf4f8eb', systemSurfaceStrong: '#ddebf5f0', systemText: '#444444', systemAccent: '#3a6a9a', systemBorder: '#b8cad8', codeSurface: '#fafaf8',
    codeText: '#222222', assistantCodeSurface: '#fafaf8', assistantCodeText: '#111827', inlineCodeSurface: '#fafaf8', inlineCodeText: '#222222',
    diffAddedSurface: '#dcefd6', diffAddedSurfaceStrong: '#bfe3b5', diffRemovedSurface: '#f6dfbf',
    diffRemovedSurfaceStrong: '#edc487', scrollbarTrack: '#f4f3ef', scrollbarThumb: '#cccccc',
    scrollbarThumbHover: '#aaaaaa', contextViewport: '#000000', terminalBackground: '#fafaf8', terminalForeground: '#222222',
    terminalCursor: '#cc3333', terminalSelection: '#cc333344',
  },
  typography: consoleTypography,
  shape: consoleShape,
  effects: consoleEffects,
  backgroundPattern: { kind: 'grid', sizePx: 20, opacity: 0.02 },
})

const consoleDark = variant({
  componentTreatment: 'console',
  colors: {
    canvas: '#0c0c0c', canvasEdge: '#080808', surface: '#111111', surfaceRaised: '#181818',
    surfaceSunken: '#0a0a0a', input: '#0a0a0a', overlay: '#000000b3', hover: '#181818',
    selected: '#2a1717', borderMuted: '#1e1e1e', border: '#252525', borderStrong: '#444444',
    text: '#999999', textMuted: '#777777', textSubtle: '#555555', textStrong: '#cccccc',
    textInverse: '#ffffff', accent: '#ee5555', accentMuted: '#bb4444', accentSurface: '#2d1515',
    accentSurfaceStrong: '#401c1c', accentBorder: '#6b2c2c', focusRing: '#ee5555', neutral: '#999999',
    neutralSurface: '#181818', neutralBorder: '#444444', info: '#77aabb', infoSurface: '#0c1824',
    infoSurfaceStrong: '#1a3555', infoBorder: '#26445f', success: '#55aa55', successSurface: '#0a1f0a',
    successSurfaceStrong: '#123212', successBorder: '#1a3a28', warning: '#d08a45', warningSurface: '#5c301057',
    warningSurfaceStrong: '#8c4e1c6b', warningBorder: '#5a351c', danger: '#d08a45', dangerSurface: '#5c301057',
    dangerSurfaceStrong: '#8c4e1c6b', dangerBorder: '#5a351c', special: '#8866ee', specialSurface: '#251a3f',
    specialBorder: '#3a2a64', userSurface: '#bb4444', userText: '#ffffff', assistantSurface: '#111111',
    assistantText: '#cccccc', threadText: '#999999', reasoningSurface: '#111111', reasoningSurfaceStrong: '#181818',
    systemSurface: '#0c1824c7', systemSurfaceStrong: '#1a3555c7', systemText: '#999999', systemAccent: '#77aabb', systemBorder: '#26445f', codeSurface: '#0a0a0a',
    codeText: '#cccccc', assistantCodeSurface: '#0a0a0a', assistantCodeText: '#f3f4f6', inlineCodeSurface: '#0a0a0a', inlineCodeText: '#cccccc',
    diffAddedSurface: '#1652247a', diffAddedSurfaceStrong: '#46964e8a', diffRemovedSurface: '#76401675',
    diffRemovedSurfaceStrong: '#be702885', scrollbarTrack: '#0c0c0c', scrollbarThumb: '#2a2a2a',
    scrollbarThumbHover: '#3a3a3a', contextViewport: '#ffffff', terminalBackground: '#0a0a0a', terminalForeground: '#cccccc',
    terminalCursor: '#ee5555', terminalSelection: '#ee555544',
  },
  typography: consoleTypography,
  shape: consoleShape,
  effects: consoleEffects,
  backgroundPattern: { kind: 'grid', sizePx: 20, opacity: 0.035 },
})

export const THEME_550A = checkedBuiltin({
  schemaVersion: 1,
  id: THEME_550A_ID,
  name: '550A',
  description: 'A dense monospace console theme with a red accent and subtle grid.',
  author: 'Foxwarm',
  variants: { light: consoleLight, dark: consoleDark },
})

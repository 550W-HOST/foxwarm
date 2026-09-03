import { checkedBuiltin, variant } from './shared'

export const DEFAULT_THEME_ID = 'foxwarm.default'

const defaultLight = variant({
  colors: {
    canvas: '#f3f4f6', canvasEdge: '#e5e7eb', surface: '#ffffff', surfaceRaised: '#ffffff',
    surfaceSunken: '#f9fafb', input: '#ffffff', overlay: '#00000080', hover: '#f3f4f6',
    selected: '#dbeafe', borderMuted: '#f3f4f6', border: '#e5e7eb', borderStrong: '#d1d5db',
    text: '#374151', textMuted: '#6b7280', textSubtle: '#9ca3af', textStrong: '#111827',
    textInverse: '#ffffff', accent: '#3b82f6', accentMuted: '#2563eb', accentSurface: '#eff6ff',
    accentSurfaceStrong: '#dbeafe', accentBorder: '#93c5fd', focusRing: '#3b82f6', neutral: '#6b7280',
    neutralSurface: '#f3f4f6', neutralBorder: '#d1d5db', info: '#2563eb', infoSurface: '#eff6ff',
    infoSurfaceStrong: '#dbeafe', infoBorder: '#93c5fd', success: '#15803d', successSurface: '#f0fdf4',
    successSurfaceStrong: '#dcfce7', successBorder: '#86efac', warning: '#b45309', warningSurface: '#fffbeb',
    warningSurfaceStrong: '#fef3c7', warningBorder: '#fcd34d', danger: '#dc2626', dangerSurface: '#fef2f2',
    dangerSurfaceStrong: '#fee2e2', dangerBorder: '#fca5a5', special: '#7e22ce', specialSurface: '#faf5ff',
    specialBorder: '#d8b4fe', userSurface: '#3b82f6', userText: '#ffffff', assistantSurface: '#ffffff',
    assistantText: '#111827', threadText: '#334155', reasoningSurface: '#f1f5f9', reasoningSurfaceStrong: '#e2e8f0',
    systemSurface: '#eff6ff', systemSurfaceStrong: '#dbeafe', systemText: '#334155', systemAccent: '#93c5fd', systemBorder: '#bfdbfe', codeSurface: '#f3f4f6',
    codeText: '#111827', assistantCodeSurface: '#f3f4f6', assistantCodeText: '#111827', inlineCodeSurface: '#f3f4f6', inlineCodeText: '#111827',
    diffAddedSurface: '#dcfce7', diffAddedSurfaceStrong: '#bbf7d0', diffRemovedSurface: '#fee2e2',
    diffRemovedSurfaceStrong: '#fecaca', scrollbarTrack: '#f3f4f6', scrollbarThumb: '#d1d5db',
    scrollbarThumbHover: '#9ca3af', contextViewport: '#000000', terminalBackground: '#111827', terminalForeground: '#e5e7eb',
    terminalCursor: '#f9fafb', terminalSelection: '#3b82f666',
  },
})

const defaultDark = variant({
  colors: {
    canvas: '#111827', canvasEdge: '#030712', surface: '#1f2937', surfaceRaised: '#374151',
    surfaceSunken: '#111827', input: '#111827', overlay: '#000000b3', hover: '#374151',
    selected: '#1e3a8a', borderMuted: '#1f2937', border: '#374151', borderStrong: '#4b5563',
    text: '#d1d5db', textMuted: '#9ca3af', textSubtle: '#6b7280', textStrong: '#f3f4f6',
    textInverse: '#ffffff', accent: '#60a5fa', accentMuted: '#3b82f6', accentSurface: '#172554',
    accentSurfaceStrong: '#1e3a8a', accentBorder: '#2563eb', focusRing: '#60a5fa', neutral: '#9ca3af',
    neutralSurface: '#374151', neutralBorder: '#4b5563', info: '#93c5fd', infoSurface: '#172554',
    infoSurfaceStrong: '#1e3a8a', infoBorder: '#1d4ed8', success: '#4ade80', successSurface: '#052e16',
    successSurfaceStrong: '#14532d', successBorder: '#166534', warning: '#fbbf24', warningSurface: '#451a03',
    warningSurfaceStrong: '#78350f', warningBorder: '#92400e', danger: '#f87171', dangerSurface: '#450a0a',
    dangerSurfaceStrong: '#7f1d1d', dangerBorder: '#991b1b', special: '#c084fc', specialSurface: '#3b0764',
    specialBorder: '#6b21a8', userSurface: '#2563eb', userText: '#ffffff', assistantSurface: '#1f2937',
    assistantText: '#f3f4f6', threadText: '#cbd5e1', reasoningSurface: '#1e293b', reasoningSurfaceStrong: '#334155',
    systemSurface: '#1e3a8a', systemSurfaceStrong: '#1e40af', systemText: '#cbd5e1', systemAccent: '#1d4ed8', systemBorder: '#1e40af', codeSurface: '#111827',
    codeText: '#f3f4f6', assistantCodeSurface: '#111827', assistantCodeText: '#f3f4f6', inlineCodeSurface: '#111827', inlineCodeText: '#e5e7eb',
    diffAddedSurface: '#052e16', diffAddedSurfaceStrong: '#14532d', diffRemovedSurface: '#450a0a',
    diffRemovedSurfaceStrong: '#7f1d1d', scrollbarTrack: '#111827', scrollbarThumb: '#374151',
    scrollbarThumbHover: '#4b5563', contextViewport: '#ffffff', terminalBackground: '#111827', terminalForeground: '#e5e7eb',
    terminalCursor: '#f9fafb', terminalSelection: '#60a5fa66',
  },
})

export const DEFAULT_THEME = checkedBuiltin({
  schemaVersion: 1,
  id: DEFAULT_THEME_ID,
  name: 'Default',
  description: 'Foxwarm’s standard application theme.',
  author: 'Foxwarm',
  variants: { light: defaultLight, dark: defaultDark },
})

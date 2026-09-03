import type { ThemeRuntimeSnapshot } from './runtime'

export function terminalThemeFromSnapshot(snapshot: ThemeRuntimeSnapshot) {
  const colors = snapshot.activeTheme.variants[snapshot.effectiveMode].colors
  return {
    background: colors.terminalBackground,
    foreground: colors.terminalForeground,
    cursor: colors.terminalCursor,
    cursorAccent: colors.terminalBackground,
    selectionBackground: colors.terminalSelection,
    black: colors.canvasEdge,
    red: colors.danger,
    green: colors.success,
    yellow: colors.warning,
    blue: colors.info,
    magenta: colors.special,
    cyan: colors.accent,
    white: colors.text,
    brightBlack: colors.textSubtle,
    brightRed: colors.danger,
    brightGreen: colors.success,
    brightYellow: colors.warning,
    brightBlue: colors.info,
    brightMagenta: colors.special,
    brightCyan: colors.accent,
    brightWhite: colors.textStrong,
  }
}

export function monacoThemeFromSnapshot(snapshot: ThemeRuntimeSnapshot) {
  const colors = snapshot.activeTheme.variants[snapshot.effectiveMode].colors
  return {
    base: snapshot.effectiveMode === 'dark' ? 'vs-dark' as const : 'vs' as const,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': colors.codeSurface,
      'editor.foreground': colors.codeText,
      'editorCursor.foreground': colors.accent,
      'editor.selectionBackground': colors.terminalSelection,
      'editor.inactiveSelectionBackground': colors.selected,
      'editor.lineHighlightBackground': colors.hover,
      'editorLineNumber.foreground': colors.textSubtle,
      'editorLineNumber.activeForeground': colors.text,
      'editorWidget.background': colors.surfaceRaised,
      'editorWidget.border': colors.border,
      'input.background': colors.input,
      'input.foreground': colors.text,
      'input.border': colors.border,
      'focusBorder': colors.focusRing,
    },
  }
}

export function mermaidThemeFromSnapshot(snapshot: ThemeRuntimeSnapshot) {
  const colors = snapshot.activeTheme.variants[snapshot.effectiveMode].colors
  return {
    theme: snapshot.effectiveMode === 'dark' ? 'dark' as const : 'neutral' as const,
    themeVariables: {
      background: colors.canvas,
      primaryColor: colors.accentSurface,
      primaryTextColor: colors.textStrong,
      primaryBorderColor: colors.accentBorder,
      secondaryColor: colors.infoSurface,
      secondaryTextColor: colors.text,
      secondaryBorderColor: colors.infoBorder,
      tertiaryColor: colors.surfaceSunken,
      tertiaryTextColor: colors.text,
      tertiaryBorderColor: colors.border,
      lineColor: colors.borderStrong,
      textColor: colors.text,
      mainBkg: colors.surface,
      nodeBorder: colors.borderStrong,
      clusterBkg: colors.surfaceSunken,
      clusterBorder: colors.border,
      edgeLabelBackground: colors.surfaceRaised,
      noteBkgColor: colors.warningSurface,
      noteTextColor: colors.text,
      noteBorderColor: colors.warningBorder,
      actorBkg: colors.surface,
      actorBorder: colors.borderStrong,
      actorTextColor: colors.textStrong,
      signalColor: colors.text,
      signalTextColor: colors.text,
      labelBoxBkgColor: colors.surface,
      labelBoxBorderColor: colors.border,
      labelTextColor: colors.text,
      loopTextColor: colors.text,
      activationBkgColor: colors.accentSurface,
      activationBorderColor: colors.accentBorder,
      sequenceNumberColor: colors.textInverse,
    },
  }
}

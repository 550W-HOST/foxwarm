const foxwarmColor = (name) => ({ opacityValue }) => {
  const color = `var(--foxwarm-color-${name})`
  if (opacityValue === undefined) return color
  const numericOpacity = Number(opacityValue)
  const percentage = Math.round(numericOpacity * 10_000) / 100
  return Number.isFinite(numericOpacity)
    ? `color-mix(in srgb, ${color} ${percentage}%, transparent)`
    : color
}

const foxwarmColors = Object.fromEntries([
  'canvas', 'canvas-edge', 'surface', 'surface-raised', 'surface-sunken', 'input', 'overlay',
  'hover', 'selected', 'border-muted', 'border', 'border-strong', 'text', 'text-muted',
  'text-subtle', 'text-strong', 'text-inverse', 'accent', 'accent-muted', 'accent-surface',
  'accent-surface-strong', 'accent-border', 'focus-ring', 'neutral', 'neutral-surface',
  'neutral-border', 'info', 'info-surface', 'info-surface-strong', 'info-border', 'success',
  'success-surface', 'success-surface-strong', 'success-border', 'warning', 'warning-surface',
  'warning-surface-strong', 'warning-border', 'danger', 'danger-surface', 'danger-surface-strong',
  'danger-border', 'special', 'special-surface', 'special-border', 'user-surface', 'user-text',
  'assistant-surface', 'assistant-text', 'thread-text', 'reasoning-surface', 'reasoning-surface-strong',
  'system-surface', 'system-surface-strong', 'system-text', 'system-accent', 'system-border', 'code-surface',
  'code-text', 'assistant-code-surface', 'assistant-code-text', 'inline-code-surface', 'inline-code-text', 'diff-added-surface',
  'diff-added-surface-strong', 'diff-removed-surface', 'diff-removed-surface-strong',
  'scrollbar-track', 'scrollbar-thumb', 'scrollbar-thumb-hover', 'context-viewport', 'terminal-background',
  'terminal-foreground', 'terminal-cursor', 'terminal-selection',
].map(name => [name, foxwarmColor(name)]))

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: { fw: foxwarmColors },
      fontFamily: {
        'fw-ui': ['var(--foxwarm-ui-font-family)'],
        'fw-message': ['var(--foxwarm-message-font-family)'],
        'fw-code': ['var(--foxwarm-code-font-family)'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}

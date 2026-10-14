import type { ThemeManifest } from '../manifest'
import { THEME_550A } from './550a'
import { THEME_550A_MONO } from './550a-mono'
import { THEME_SEA_GLASS } from './seaglass'
import { DEFAULT_THEME } from './default'
import { THEME_FOXWARM } from './foxwarm'
import { THEME_VECTOR } from './vector'
import { THEME_CATPPUCCIN } from './catppuccin'
import { THEME_PAPER } from './paper'

export { THEME_550A, THEME_550A_ID } from './550a'
export { THEME_550A_MONO, THEME_550A_MONO_ID } from './550a-mono'
export { DEFAULT_THEME, DEFAULT_THEME_ID } from './default'
export { THEME_FOXWARM, THEME_FOXWARM_ID } from './foxwarm'
export { THEME_SEA_GLASS, THEME_SEA_GLASS_ID } from './seaglass'
export { THEME_VECTOR, THEME_VECTOR_ID } from './vector'
export { THEME_CATPPUCCIN, THEME_CATPPUCCIN_ID } from './catppuccin'
export { THEME_PAPER, THEME_PAPER_ID } from './paper'

export const BUILTIN_THEMES: readonly ThemeManifest[] = [
  DEFAULT_THEME,
  THEME_FOXWARM,
  THEME_550A,
  THEME_550A_MONO,
  THEME_PAPER,
  THEME_SEA_GLASS,
  THEME_VECTOR,
  THEME_CATPPUCCIN,
]

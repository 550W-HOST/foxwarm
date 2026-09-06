import type { ThemeManifest } from '../manifest'
import { THEME_550A } from './550a'
import { THEME_SEA_GLASS } from './seaglass'
import { DEFAULT_THEME } from './default'
import { THEME_VECTOR } from './vector'
import { THEME_PAPER } from './paper'

export { THEME_550A, THEME_550A_ID } from './550a'
export { DEFAULT_THEME, DEFAULT_THEME_ID } from './default'
export { THEME_SEA_GLASS, THEME_SEA_GLASS_ID } from './seaglass'
export { THEME_VECTOR, THEME_VECTOR_ID } from './vector'
export { THEME_PAPER, THEME_PAPER_ID } from './paper'

export const BUILTIN_THEMES: readonly ThemeManifest[] = [
  DEFAULT_THEME,
  THEME_550A,
  THEME_PAPER,
  THEME_SEA_GLASS,
  THEME_VECTOR,
]

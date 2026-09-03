import type { ThemeManifestV1 } from '../manifest'
import { THEME_550A } from './550a'
import { DEFAULT_THEME } from './default'

export { THEME_550A, THEME_550A_ID } from './550a'
export { DEFAULT_THEME, DEFAULT_THEME_ID } from './default'

export const BUILTIN_THEMES: readonly ThemeManifestV1[] = [DEFAULT_THEME, THEME_550A]

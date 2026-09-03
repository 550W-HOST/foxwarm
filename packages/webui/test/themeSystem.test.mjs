import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-theme-system-test-'))
const bundlePath = path.join(tempDir, 'theme.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/theme/index.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const theme = await import(pathToFileURL(bundlePath).href)

after(async () => rm(tempDir, { recursive: true, force: true }))

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

test('built-in themes validate and canonical serialization is stable', () => {
  assert.deepEqual(theme.BUILTIN_THEMES.map(item => item.id), ['foxwarm.default', 'foxwarm.550a'])
  for (const builtin of theme.BUILTIN_THEMES) {
    const serialized = theme.serializeThemeManifest(builtin)
    const parsed = theme.parseThemeManifestJson(serialized)
    assert.equal(parsed.ok, true)
    assert.equal(theme.serializeThemeManifest(parsed.value), serialized)
  }
})

test('manifest validation is strict and rejects arbitrary style surface', () => {
  const candidate = structuredClone(theme.DEFAULT_THEME)
  candidate.selector = 'body { display: none }'
  candidate.variants.dark.colors.canvas = 'url(https://example.invalid/a)'
  delete candidate.variants.light.colors.text
  const result = theme.validateThemeManifest(candidate)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes('theme.selector is not supported')))
  assert.ok(result.errors.some(error => error.includes('dark.colors.canvas')))
  assert.ok(result.errors.some(error => error.includes('light.colors.text')))
})

test('validation reports bounded readability warnings without making a safe manifest executable', () => {
  const candidate = structuredClone(theme.DEFAULT_THEME)
  candidate.id = 'example.low-contrast'
  candidate.variants.light.colors.text = candidate.variants.light.colors.surface
  const result = theme.validateThemeManifest(candidate)
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(warning => warning.includes('light text on surface contrast')))
})

test('legacy selection migrates to a versioned theme family selection', () => {
  const storage = new MemoryStorage()
  storage.setItem('themeMode', 'dark')
  storage.setItem('foxwarm_ui_theme_style_v1', '550a')
  assert.deepEqual(theme.readThemeSelection(storage), {
    version: 1,
    themeId: 'foxwarm.550a',
    colorMode: 'dark',
  })
  assert.deepEqual(JSON.parse(storage.getItem('foxwarm_theme_selection_v1')), {
    version: 1,
    themeId: 'foxwarm.550a',
    colorMode: 'dark',
  })
})

test('custom themes install, conflict, export, replace, and delete atomically', () => {
  const storage = new MemoryStorage()
  const custom = structuredClone(theme.THEME_550A)
  custom.id = 'example.console'
  custom.name = 'Example Console'
  const serialized = theme.serializeThemeManifest(custom)

  const installed = theme.installThemeFromJson(storage, serialized)
  assert.equal(installed.ok, true)
  assert.equal(installed.replaced, false)
  assert.equal(theme.readThemeRegistry(storage).customThemes.length, 1)
  assert.equal(theme.exportThemeById(storage, custom.id), serialized)

  const conflict = theme.installThemeFromJson(storage, serialized)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflictTheme.id, custom.id)

  custom.name = 'Replaced Console'
  const replaced = theme.installThemeFromJson(storage, theme.serializeThemeManifest(custom), { replace: true })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.replaced, true)
  assert.equal(theme.readThemeRegistry(storage).customThemes[0].name, 'Replaced Console')
  assert.equal(theme.deleteCustomTheme(storage, custom.id), true)
  assert.equal(theme.readThemeRegistry(storage).customThemes.length, 0)
})

test('custom themes cannot claim built-in namespace and exported 550A clone resolves equally', () => {
  const storage = new MemoryStorage()
  const reserved = structuredClone(theme.THEME_550A)
  const rejected = theme.installThemeFromJson(storage, theme.serializeThemeManifest(reserved))
  assert.equal(rejected.ok, false)
  assert.match(rejected.errors.join('\n'), /reserved/)

  const clone = structuredClone(theme.THEME_550A)
  clone.id = 'example.reimported-550a'
  clone.name = 'Reimported 550A'
  assert.equal(theme.installThemeFromJson(storage, theme.serializeThemeManifest(clone)).ok, true)
  const installed = theme.readThemeRegistry(storage).customThemes[0]
  assert.deepEqual(
    theme.themeVariantCssVariables(installed.variants.dark),
    theme.themeVariantCssVariables(theme.THEME_550A.variants.dark),
  )
})

test('terminal, Monaco, and Mermaid adapters consume the same resolved manifest variant', () => {
  const snapshot = {
    selection: { version: 1, themeId: 'foxwarm.550a', colorMode: 'light' },
    effectiveMode: 'light',
    activeTheme: theme.THEME_550A,
    registry: theme.readThemeRegistry(new MemoryStorage()),
    systemPrefersDark: false,
  }
  const colors = theme.THEME_550A.variants.light.colors
  assert.equal(theme.terminalThemeFromSnapshot(snapshot).background, colors.terminalBackground)
  assert.equal(theme.monacoThemeFromSnapshot(snapshot).colors['editor.background'], colors.codeSurface)
  assert.equal(theme.mermaidThemeFromSnapshot(snapshot).themeVariables.primaryColor, colors.accentSurface)
})

test('shape, effects, typography, and bounded background fields project to runtime variables', () => {
  const variant = structuredClone(theme.DEFAULT_THEME.variants.light)
  variant.shape = { radiusSmallPx: 2, radiusMediumPx: 7, radiusLargePx: 15, borderWidthPx: 2, controlHeightPx: 39 }
  variant.effects = { shadowColor: '#123456', shadowOpacity: 0.23, shadowBlurPx: 17, glowOpacity: 0.31, pressOffsetPx: 2, transitionMs: 240 }
  variant.typography = { ...variant.typography, uiFontFamily: 'system-ui', messageFontSizePx: 17, codeLineHeight: 1.7 }
  variant.backgroundPattern = { kind: 'grid', sizePx: 28, opacity: 0.08 }
  const variables = theme.themeVariantCssVariables(variant)
  assert.equal(variables['--foxwarm-radius-medium-px'], '7px')
  assert.equal(variables['--foxwarm-control-height-px'], '39px')
  assert.equal(variables['--foxwarm-transition-ms'], '240ms')
  assert.equal(variables['--foxwarm-press-transform'], 'translateY(2px)')
  assert.match(variables['--foxwarm-panel-shadow'], /17px.*#123456 23%/)
  assert.match(variables['--foxwarm-accent-glow'], /17px.*31%/)
  assert.equal(variables['--foxwarm-ui-font-family'], 'system-ui')
  assert.equal(variables['--foxwarm-message-font-size-px'], '17px')
  assert.equal(variables['--foxwarm-code-line-height'], '1.7')
  assert.equal(variables['--foxwarm-background-size'], '28px 28px')
  assert.match(variables['--foxwarm-background-image'], /linear-gradient/)
})

test('WebUI TypeScript components use semantic theme utilities rather than fixed Tailwind palettes', async () => {
  const componentsRoot = path.join(webuiRoot, 'src/components')
  const files = (await readdir(componentsRoot)).filter(file => file.endsWith('.tsx'))
  const fixedPalette = /\b(?:bg|text|border|ring|from|to|via|divide|placeholder|decoration)-(?:gray|slate|zinc|neutral|stone|blue|sky|cyan|red|rose|green|emerald|amber|yellow|orange|purple|violet|indigo|white|black)(?:-|\/|\b)/
  const violations = []
  for (const file of files) {
    const source = await readFile(path.join(componentsRoot, file), 'utf8')
    if (fixedPalette.test(source)) violations.push(file)
  }
  assert.deepEqual(violations, [])
})

test('Architecture inverse icon and active-tab treatments use a readable semantic pair', async () => {
  const source = await readFile(path.join(webuiRoot, 'src/components/ArchitectureView.tsx'), 'utf8')
  assert.match(source, /bg-fw-text-strong text-fw-surface"><Network/)
  assert.equal((source.match(/bg-fw-text-strong text-fw-surface/g) || []).length >= 3, true)
  assert.doesNotMatch(source, /bg-fw-canvas text-fw-text-inverse/)
})

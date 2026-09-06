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
  assert.ok(theme.BUILTIN_THEMES.includes(theme.DEFAULT_THEME))
  assert.ok(theme.BUILTIN_THEMES.includes(theme.THEME_550A))
  assert.ok(theme.BUILTIN_THEMES.includes(theme.THEME_550A_MONO))
  assert.equal(theme.BUILTIN_THEMES.length, 6)
  assert.deepEqual(
    theme.BUILTIN_THEMES.map(item => [item.id, item.name]),
    [
      ['foxwarm.default', 'Default'],
      ['foxwarm.550a', '550A'],
      ['foxwarm.550a-mono', '550A Mono'],
      ['foxwarm.paper', 'Paper'],
      ['foxwarm.seaglass', 'Sea Glass'],
      ['foxwarm.vector', 'Vector'],
    ],
  )
  assert.equal(new Set(theme.BUILTIN_THEMES.map(item => item.id)).size, theme.BUILTIN_THEMES.length)
  for (const builtin of theme.BUILTIN_THEMES) {
    const serialized = theme.serializeThemeManifest(builtin)
    const parsed = theme.parseThemeManifestJson(serialized)
    assert.equal(parsed.ok, true)
    assert.equal(theme.serializeThemeManifest(parsed.value), serialized)
    assert.deepEqual(parsed.value.variants.light.colors, builtin.variants.light.colors)
    assert.deepEqual(parsed.value.variants.dark.colors, builtin.variants.dark.colors)
    assert.ok(Array.isArray(parsed.warnings))
  }
})

test('550A keeps its colored console grammar while 550A Mono preserves the machine-console palette', () => {
  for (const mode of ['light', 'dark']) {
    const colored = theme.THEME_550A.variants[mode]
    const mono = theme.THEME_550A_MONO.variants[mode]
    assert.equal(colored.componentTreatment, 'console')
    assert.equal(mono.componentTreatment, 'console')
    assert.notEqual(colored.colors.tool, colored.colors.systemAccent)
    assert.notEqual(colored.colors.toolSurface, colored.colors.systemSurface)
  }

  assert.equal(theme.THEME_550A.variants.light.colors.tool, '#3a7a3a')
  assert.equal(theme.THEME_550A.variants.light.colors.systemAccent, '#3a6a9a')
  assert.equal(theme.THEME_550A.variants.dark.colors.tool, '#55aa55')
  assert.equal(theme.THEME_550A.variants.dark.colors.systemAccent, '#77aabb')
  assert.equal(theme.THEME_550A.variants.light.typography.uiFontFamily, theme.THEME_550A.variants.light.typography.codeFontFamily)

  assert.equal(theme.THEME_550A_MONO.variants.light.colors.canvas, '#dcdfde')
  assert.equal(theme.THEME_550A_MONO.variants.light.colors.tool, '#4d5652')
  assert.equal(theme.THEME_550A_MONO.variants.dark.colors.canvas, '#121414')
  assert.equal(theme.THEME_550A_MONO.variants.dark.colors.tool, '#b7bfbb')
  assert.equal(theme.THEME_550A_MONO.variants.dark.displayEffect.kind, 'crt')
})

test('schema V2 gives tools one coherent family while Default preserves its historical colors', async () => {
  for (const mode of ['light', 'dark']) {
    const colors = theme.DEFAULT_THEME.variants[mode].colors
    assert.deepEqual(
      [colors.tool, colors.toolSurface, colors.toolSurfaceStrong, colors.toolBorder],
      [colors.success, colors.successSurface, colors.successSurfaceStrong, colors.successBorder],
    )
    assert.deepEqual(
      [colors.diffAddedText, colors.diffRemovedText],
      [colors.accent, colors.warning],
    )
    assert.deepEqual(
      [colors.syntaxComment, colors.syntaxString, colors.syntaxNumber, colors.syntaxKeyword, colors.syntaxLiteral, colors.syntaxHeading, colors.syntaxTag, colors.syntaxAttribute, colors.syntaxProperty],
      [colors.textMuted, colors.success, colors.accent, colors.special, colors.info, colors.textStrong, colors.danger, colors.warning, colors.info],
    )
  }
  const timeline = await readFile(path.join(webuiRoot, 'src/components/ToolTimelineItems.tsx'), 'utf8')
  const shared = await readFile(path.join(webuiRoot, 'src/components/chatShared.tsx'), 'utf8')
  const syntax = await readFile(path.join(webuiRoot, 'src/components/SyntaxHighlightedText.tsx'), 'utf8')
  const diff = await readFile(path.join(webuiRoot, 'src/components/DiffPreview.tsx'), 'utf8')
  const styles = await readFile(path.join(webuiRoot, 'src/index.css'), 'utf8')
  assert.match(timeline, /text-fw-tool/)
  assert.match(timeline, /bg-fw-tool-surface/)
  assert.match(timeline, /border-fw-tool-border/)
  assert.match(shared, /border-fw-tool-border bg-fw-tool-surface text-fw-tool/)
  assert.match(syntax, /text-fw-syntax-string/)
  assert.match(syntax, /text-fw-syntax-property/)
  assert.match(diff, /text-fw-diff-added-text/)
  assert.match(diff, /text-fw-diff-removed-text/)
  assert.match(styles, /context-scrollbar-tone-tool-success \{ background: var\(--foxwarm-color-tool\)/)
  assert.match(styles, /context-scrollbar-category-tools \{ background: var\(--foxwarm-color-tool\)/)
  assert.doesNotMatch(styles, /context-scrollbar-(?:tone-tool-success|category-tools)[^\n]*color-success/)
})

test('bounded composition recipes preserve the Default contract and project through runtime CSS', async () => {
  assert.deepEqual(theme.DEFAULT_THEME.variants.light.composition, {
    density: 'comfortable', card: 'flat', header: 'banded', control: 'soft',
    separator: 'rail', labels: 'uppercase', icons: 'standard',
  })
  assert.equal(theme.DEFAULT_THEME.variants.light.shape.messageRadiusPx, 8)
  assert.equal(theme.DEFAULT_THEME.variants.light.shape.cardRadiusPx, 0)
  assert.equal(theme.DEFAULT_THEME.variants.light.shape.composerRadiusPx, 30)
  assert.equal(theme.DEFAULT_THEME.variants.light.shape.cardInsetPx, 8)

  const runtime = await readFile(path.join(webuiRoot, 'src/theme/runtime.ts'), 'utf8')
  const styles = await readFile(path.join(webuiRoot, 'src/index.css'), 'utf8')
  assert.match(runtime, /dataset\.foxwarmThemeDensity = variant\.composition\.density/)
  assert.match(runtime, /dataset\.foxwarmHeaderTreatment = variant\.composition\.header/)
  assert.match(styles, /data-foxwarm-card-treatment="elevated"/)
  assert.match(styles, /data-foxwarm-header-treatment="integrated"/)
  assert.match(styles, /data-foxwarm-separator-treatment="segmented"/)
  assert.match(styles, /--foxwarm-message-radius-px/)
})

test('manifest validation is strict and rejects arbitrary style surface', () => {
  const candidate = structuredClone(theme.DEFAULT_THEME)
  candidate.selector = 'body { display: none }'
  candidate.variants.dark.colors.canvas = 'url(https://example.invalid/a)'
  delete candidate.variants.light.colors.text
  delete candidate.variants.light.colors.tool
  delete candidate.variants.light.composition
  const result = theme.validateThemeManifest(candidate)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes('theme.selector is not supported')))
  assert.ok(result.errors.some(error => error.includes('dark.colors.canvas')))
  assert.ok(result.errors.some(error => error.includes('light.colors.text')))
  assert.ok(result.errors.some(error => error.includes('light.colors.tool')))
  assert.ok(result.errors.some(error => error.includes('light.composition')))
})

test('CRT display effects are portable bounded data rather than executable styling', () => {
  const candidate = structuredClone(theme.DEFAULT_THEME)
  candidate.id = 'example.crt'
  candidate.variants.light.displayEffect = {
    kind: 'crt', mask: 'monochrome', bezel: 'frame', scanPitchPx: 6, scanOpacity: 0.12,
    maskPitchPx: 4, maskOpacity: 0.03, bloomPx: 0.8, bloomOpacity: 0.12,
    vignetteOpacity: 0.12, reflectionOpacity: 0.06, rollOpacity: 0.04,
    rollDurationSec: 18, glassRadiusPx: 14,
  }
  assert.equal(theme.validateThemeManifest(candidate).ok, true)
  candidate.variants.light.displayEffect.scanOpacity = 0.9
  candidate.variants.light.displayEffect.shader = 'remote-code'
  const invalid = theme.validateThemeManifest(candidate)
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some(error => error.includes('displayEffect.scanOpacity')))
  assert.ok(invalid.errors.some(error => error.includes('displayEffect.shader is not supported')))
})

test('version-1 manifests are rejected instead of receiving implicit visual semantics', () => {
  const legacy = structuredClone(theme.DEFAULT_THEME)
  legacy.schemaVersion = 1
  for (const variant of Object.values(legacy.variants)) {
    delete variant.colors.tool
    delete variant.colors.toolSurface
    delete variant.colors.toolSurfaceStrong
    delete variant.colors.toolBorder
  }
  const result = theme.validateThemeManifest(legacy)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes('schemaVersion must be 2')))
  assert.ok(result.errors.some(error => error.includes('colors.tool')))
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
    version: 2,
    themeId: 'foxwarm.550a',
    colorMode: 'dark',
  })
  assert.deepEqual(JSON.parse(storage.getItem('foxwarm_theme_selection_v2')), {
    version: 2,
    themeId: 'foxwarm.550a',
    colorMode: 'dark',
  })
})

test('current selections retain both stable 550A family IDs', () => {
  for (const themeId of ['foxwarm.550a', 'foxwarm.550a-mono']) {
    const storage = new MemoryStorage()
    storage.setItem('foxwarm_theme_selection_v2', JSON.stringify({ version: 2, themeId, colorMode: 'dark' }))
    assert.deepEqual(theme.readThemeSelection(storage), { version: 2, themeId, colorMode: 'dark' })
    assert.equal(theme.readThemeRegistry(storage).themes.some(item => item.id === themeId), true)
  }
})

test('V2 selection is insulated from rewrites by an older live WebUI bundle', () => {
  const storage = new MemoryStorage()
  storage.setItem('foxwarm_theme_selection_v1', JSON.stringify({ version: 1, themeId: 'foxwarm.new-built-in', colorMode: 'dark' }))
  assert.deepEqual(theme.readThemeSelection(storage), { version: 2, themeId: 'foxwarm.new-built-in', colorMode: 'dark' })
  storage.setItem('foxwarm_theme_selection_v1', JSON.stringify({ version: 1, themeId: 'foxwarm.default', colorMode: 'light' }))
  assert.deepEqual(theme.readThemeSelection(storage), { version: 2, themeId: 'foxwarm.new-built-in', colorMode: 'dark' })
})

test('runtime fallback does not overwrite a theme unknown to an older WebUI bundle', async () => {
  const runtimeSource = await readFile(path.join(webuiRoot, 'src/theme/runtime.ts'), 'utf8')
  const fallbackBody = runtimeSource.match(/if \(!activeTheme\) \{([\s\S]*?)\n  \}/)?.[1] || ''
  assert.match(fallbackBody, /themeId: DEFAULT_THEME_ID/)
  assert.doesNotMatch(fallbackBody, /writeThemeSelection/)
  assert.match(fallbackBody, /older WebUI bundle/)
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

test('custom themes cannot claim built-in namespace and exported console clones resolve equally', () => {
  const storage = new MemoryStorage()
  const reserved = structuredClone(theme.THEME_550A)
  const rejected = theme.installThemeFromJson(storage, theme.serializeThemeManifest(reserved))
  assert.equal(rejected.ok, false)
  assert.match(rejected.errors.join('\n'), /reserved/)

  for (const [index, builtin] of [theme.THEME_550A, theme.THEME_550A_MONO].entries()) {
    const clone = structuredClone(builtin)
    clone.id = `example.reimported-550a-${index}`
    clone.name = `Reimported ${builtin.name}`
    assert.equal(theme.installThemeFromJson(storage, theme.serializeThemeManifest(clone)).ok, true)
    const installed = theme.readThemeRegistry(storage).customThemes[index]
    assert.deepEqual(
      theme.themeVariantCssVariables(installed.variants.dark),
      theme.themeVariantCssVariables(builtin.variants.dark),
    )
  }
})

test('terminal, Monaco, and Mermaid adapters consume the same resolved manifest variant', () => {
  const snapshot = {
    selection: { version: 2, themeId: 'foxwarm.550a', colorMode: 'light' },
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

test('shape, effects, typography, and procedural backgrounds project to runtime variables', () => {
  const variant = structuredClone(theme.DEFAULT_THEME.variants.light)
  variant.shape = { ...variant.shape, radiusSmallPx: 2, radiusMediumPx: 7, radiusLargePx: 15, messageRadiusPx: 11, cardRadiusPx: 5, cardInsetPx: 6, borderWidthPx: 2, controlHeightPx: 39 }
  variant.effects = { shadowColor: '#123456', shadowOpacity: 0.23, shadowBlurPx: 17, glowOpacity: 0.31, pressOffsetPx: 2, transitionMs: 240 }
  variant.typography = { ...variant.typography, uiFontFamily: 'system-ui', messageFontSizePx: 17, codeLineHeight: 1.7 }
  variant.backgroundPattern = { kind: 'grid', sizePx: 28, opacity: 0.08 }
  const variables = theme.themeVariantCssVariables(variant)
  assert.equal(variables['--foxwarm-radius-medium-px'], '7px')
  assert.equal(variables['--foxwarm-message-radius-px'], '11px')
  assert.equal(variables['--foxwarm-card-radius-px'], '5px')
  assert.equal(variables['--foxwarm-card-inset-px'], '6px')
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
  for (const kind of ['dots', 'lines', 'scanlines']) {
    variant.backgroundPattern = { kind, sizePx: 12, opacity: 0.04 }
    assert.notEqual(theme.themeVariantCssVariables(variant)['--foxwarm-background-image'], 'none')
  }
  variant.backgroundPattern = { kind: 'scanlines', sizePx: 8, opacity: 0.07 }
  const crtVariables = theme.themeVariantCssVariables(variant)
  assert.equal((crtVariables['--foxwarm-background-image'].match(/repeating-linear-gradient/g) || []).length, 1)
  assert.doesNotMatch(crtVariables['--foxwarm-background-image'], /radial-gradient|90deg/)
  assert.equal(crtVariables['--foxwarm-background-size'], '8px 8px')
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
